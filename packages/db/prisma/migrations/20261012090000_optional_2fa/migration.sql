-- La verificación en dos pasos deja de ser obligatoria: ningún rol la exige y se desactiva
-- para quien la tenía activada (cada usuario puede volver a activarla en Mi seguridad).
UPDATE "role" SET "requires_2fa" = false;
UPDATE "app_user" SET "totp_enabled" = false, "totp_secret" = NULL;
