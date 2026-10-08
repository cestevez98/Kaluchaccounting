-- Reglas contables garantizadas por la base de datos (no dependen de la API).
-- Ver docs/03-motor-contable.md.

-- ── Restricciones de valores ────────────────────────────────────────────────
ALTER TABLE fiscal_period ADD CONSTRAINT fiscal_period_month_chk CHECK (month BETWEEN 0 AND 13);
ALTER TABLE exchange_rate ADD CONSTRAINT exchange_rate_rate_chk CHECK (rate > 0);
ALTER TABLE journal_line ADD CONSTRAINT journal_line_rate_chk CHECK (rate > 0);
ALTER TABLE journal_line ADD CONSTRAINT journal_line_nonzero_chk CHECK (amount <> 0 OR amount_usd <> 0);
-- Mismo signo en moneda original y en USD (las líneas de revaluación tienen amount = 0).
ALTER TABLE journal_line ADD CONSTRAINT journal_line_sign_chk
  CHECK (amount = 0 OR amount_usd = 0 OR sign(amount) = sign(amount_usd));

-- ── journal_entry: periodo abierto y coherencia de fechas ───────────────────
CREATE FUNCTION trg_journal_entry_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  p fiscal_period%ROWTYPE;
BEGIN
  SELECT * INTO p FROM fiscal_period WHERE id = NEW.period_id;
  IF NOT FOUND OR p.company_id <> NEW.company_id THEN
    RAISE EXCEPTION '[INVALID_INPUT] El periodo no pertenece a la empresa del asiento' USING ERRCODE = 'P0001';
  END IF;
  IF p.month BETWEEN 1 AND 12 THEN
    IF extract(year FROM NEW.entry_date) <> p.year OR extract(month FROM NEW.entry_date) <> p.month THEN
      RAISE EXCEPTION '[INVALID_INPUT] La fecha % no corresponde al periodo %/%', NEW.entry_date, p.month, p.year
        USING ERRCODE = 'P0001';
    END IF;
  ELSIF p.month = 0 AND NEW.entry_date <> make_date(p.year, 1, 1) THEN
    RAISE EXCEPTION '[INVALID_INPUT] El periodo de apertura solo admite fecha 01/01/%', p.year USING ERRCODE = 'P0001';
  ELSIF p.month = 13 AND NEW.entry_date <> make_date(p.year, 12, 31) THEN
    RAISE EXCEPTION '[INVALID_INPUT] El periodo de cierre solo admite fecha 31/12/%', p.year USING ERRCODE = 'P0001';
  END IF;
  IF p.status = 'LOCKED' THEN
    RAISE EXCEPTION '[PERIOD_CLOSED] El periodo %/% está bloqueado', p.month, p.year USING ERRCODE = 'P0002';
  END IF;
  IF p.status = 'SOFT_CLOSED' AND coalesce(current_setting('app.allow_soft_closed', true), '') <> 'on' THEN
    RAISE EXCEPTION '[PERIOD_CLOSED] El periodo %/% está en revisión de cierre: solo el contador puede contabilizar', p.month, p.year
      USING ERRCODE = 'P0002';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER journal_entry_before_insert BEFORE INSERT ON journal_entry
  FOR EACH ROW EXECUTE FUNCTION trg_journal_entry_before_insert();

-- ── Inmutabilidad: un asiento contabilizado no se modifica ni se borra ──────
-- Única modificación permitida: POSTED → REVERSED (al anularlo con contra-asiento).
CREATE FUNCTION trg_journal_entry_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '[IMMUTABLE] Los asientos no se borran: anúlalos con un contra-asiento' USING ERRCODE = 'P0003';
  END IF;
  IF OLD.status = 'POSTED' AND NEW.status = 'REVERSED'
     AND (to_jsonb(NEW) - 'status') = (to_jsonb(OLD) - 'status') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '[IMMUTABLE] Los asientos contabilizados son inmutables' USING ERRCODE = 'P0003';
END $$;

CREATE TRIGGER journal_entry_immutable BEFORE UPDATE OR DELETE ON journal_entry
  FOR EACH ROW EXECUTE FUNCTION trg_journal_entry_immutable();

CREATE FUNCTION trg_journal_line_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '[IMMUTABLE] Las líneas de asiento son inmutables' USING ERRCODE = 'P0003';
END $$;

CREATE TRIGGER journal_line_immutable BEFORE UPDATE OR DELETE ON journal_line
  FOR EACH ROW EXECUTE FUNCTION trg_journal_line_immutable();

-- ── journal_line: desnormalización y validaciones ───────────────────────────
CREATE FUNCTION trg_journal_line_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  e journal_entry%ROWTYPE;
  e_xmin text;
  a account%ROWTYPE;
BEGIN
  SELECT * INTO e FROM journal_entry WHERE id = NEW.entry_id;
  SELECT xmin::text INTO e_xmin FROM journal_entry WHERE id = NEW.entry_id;
  -- Solo se pueden añadir líneas en la misma transacción que creó el asiento.
  IF e_xmin <> (txid_current() % 4294967296)::text THEN
    RAISE EXCEPTION '[IMMUTABLE] No se pueden añadir líneas a un asiento ya contabilizado' USING ERRCODE = 'P0003';
  END IF;
  NEW.company_id := e.company_id;
  NEW.entry_date := e.entry_date;

  SELECT * INTO a FROM account WHERE id = NEW.account_id;
  IF NOT a.postable THEN
    RAISE EXCEPTION '[INVALID_ACCOUNT] La cuenta % no admite movimientos (no es de detalle)', a.display_code USING ERRCODE = 'P0004';
  END IF;
  IF NOT a.active THEN
    RAISE EXCEPTION '[INVALID_ACCOUNT] La cuenta % está inactiva', a.display_code USING ERRCODE = 'P0004';
  END IF;
  IF a.currency_lock IS NOT NULL AND a.currency_lock <> NEW.currency THEN
    RAISE EXCEPTION '[INVALID_ACCOUNT] La cuenta % solo admite moneda %', a.display_code, a.currency_lock USING ERRCODE = 'P0004';
  END IF;
  IF a.requires_party AND NEW.party_id IS NULL THEN
    RAISE EXCEPTION '[INVALID_ACCOUNT] La cuenta % exige contraparte', a.display_code USING ERRCODE = 'P0004';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER journal_line_before_insert BEFORE INSERT ON journal_line
  FOR EACH ROW EXECUTE FUNCTION trg_journal_line_before_insert();

-- ── Cuadre: verificado al hacer COMMIT (constraint trigger diferido) ────────
CREATE FUNCTION check_entry_balanced(p_entry_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  n int;
  total numeric;
BEGIN
  SELECT count(*), coalesce(sum(amount_usd), 0) INTO n, total FROM journal_line WHERE entry_id = p_entry_id;
  IF n < 2 THEN
    RAISE EXCEPTION '[UNBALANCED] El asiento % tiene % línea(s); se necesitan al menos 2', p_entry_id, n USING ERRCODE = 'P0005';
  END IF;
  IF total <> 0 THEN
    RAISE EXCEPTION '[UNBALANCED] El asiento % no cuadra en USD (diferencia %)', p_entry_id, total USING ERRCODE = 'P0005';
  END IF;
END $$;

CREATE FUNCTION trg_entry_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'journal_entry' THEN
    PERFORM check_entry_balanced(NEW.id);
  ELSE
    PERFORM check_entry_balanced(NEW.entry_id);
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER journal_entry_balanced AFTER INSERT ON journal_entry
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION trg_entry_balanced();
CREATE CONSTRAINT TRIGGER journal_line_balanced AFTER INSERT ON journal_line
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION trg_entry_balanced();

-- ── Saldos materializados ───────────────────────────────────────────────────
CREATE FUNCTION trg_ledger_balance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  e journal_entry%ROWTYPE;
  p fiscal_period%ROWTYPE;
BEGIN
  SELECT * INTO e FROM journal_entry WHERE id = NEW.entry_id;
  SELECT * INTO p FROM fiscal_period WHERE id = e.period_id;
  INSERT INTO ledger_balance AS lb
    (company_id, book, period_id, year, month, account_id, segment_key, currency, debit_usd, credit_usd, amount_orig)
  VALUES
    (e.company_id, e.book, e.period_id, p.year, p.month, NEW.account_id,
     coalesce(NEW.segment_id, '00000000-0000-0000-0000-000000000000'::uuid), NEW.currency,
     greatest(NEW.amount_usd, 0), greatest(-NEW.amount_usd, 0), NEW.amount)
  ON CONFLICT (company_id, book, period_id, account_id, segment_key, currency) DO UPDATE SET
    debit_usd = lb.debit_usd + excluded.debit_usd,
    credit_usd = lb.credit_usd + excluded.credit_usd,
    amount_orig = lb.amount_orig + excluded.amount_orig;
  RETURN NULL;
END $$;

CREATE TRIGGER journal_line_ledger_balance AFTER INSERT ON journal_line
  FOR EACH ROW EXECUTE FUNCTION trg_ledger_balance();

-- ── Auditoría genérica ──────────────────────────────────────────────────────
-- El usuario se toma de `SET LOCAL app.user_id` (lo fija la API en cada transacción).
CREATE FUNCTION trg_audit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_j jsonb := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) END;
  new_j jsonb := CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) END;
  rec_id text;
  uid text := nullif(current_setting('app.user_id', true), '');
BEGIN
  -- Nunca guardar secretos en la auditoría.
  old_j := old_j - 'password_hash' - 'totp_secret';
  new_j := new_j - 'password_hash' - 'totp_secret';
  IF TG_OP = 'UPDATE' AND old_j = new_j THEN
    RETURN NULL;
  END IF;
  -- Motivo opcional de la operación (p. ej. reapertura de un periodo bloqueado).
  IF nullif(current_setting('app.reason', true), '') IS NOT NULL AND new_j IS NOT NULL THEN
    new_j := new_j || jsonb_build_object('_reason', current_setting('app.reason', true));
  END IF;
  rec_id := coalesce(new_j ->> 'id', old_j ->> 'id', coalesce(new_j, old_j)::text);
  INSERT INTO audit_log (table_name, record_id, action, before, after, user_id)
  VALUES (TG_TABLE_NAME, rec_id, TG_OP, old_j, new_j, uid::uuid);
  RETURN NULL;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['company', 'segment', 'dimension_value', 'account', 'account_mapping',
    'exchange_rate', 'fiscal_period', 'journal_entry', 'parameter_version', 'app_user', 'role',
    'role_permission', 'user_company_role']
  LOOP
    EXECUTE format('CREATE TRIGGER %I_audit AFTER INSERT OR UPDATE OR DELETE ON %I
                    FOR EACH ROW EXECUTE FUNCTION trg_audit()', t, t);
  END LOOP;
END $$;

-- El registro de auditoría es de solo inserción.
CREATE FUNCTION trg_audit_log_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '[IMMUTABLE] El registro de auditoría no se puede modificar' USING ERRCODE = 'P0003';
END $$;
CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION trg_audit_log_immutable();
