# Kaluch ERP

ERP financiero-operativo para Grupo Kaluch. Sustituye el libro Excel
"Balance de comprobación.xlsx" (76 hojas) por una aplicación web multiusuario
basada en un libro diario de partida doble, multi-empresa, multi-moneda y
multi-segmento.

**Estado:** Fase 0 — diseño cerrado y decisiones registradas (08/10/2026).
Siguiente: fase 1 (fundaciones + motor contable).

## Documentación de diseño

| Documento | Contenido |
|---|---|
| [00 · Análisis del Excel](docs/00-analisis-excel.md) | Volumen, cómo calcula el BC, errores detectados y criterio de conciliación |
| [01 · Arquitectura](docs/01-arquitectura.md) | Stack, módulos, despliegue, seguridad, decisiones técnicas |
| [02 · Modelo de datos (ERD)](docs/02-modelo-datos.md) | Entidades, relaciones, restricciones e índices |
| [03 · Motor contable y monedas](docs/03-motor-contable.md) | Asientos, reglas de contabilización, tasas, revaluación, cierres, con ejemplos |
| [04 · Plan de fases](docs/04-plan-de-fases.md) | Alcance, entregables y criterios de aceptación por fase |
| [05 · Decisiones](docs/05-decisiones-y-preguntas.md) | Decisiones técnicas y de negocio, despliegue en Hostinger, roles |
