# Parche y auditoría de los templates KUDE

Los templates Jasper que trae `facturacionelectronicapy-kude` recortaban en
silencio datos fiscales en el PDF (incidente 2026-09-15): los últimos 8
dígitos del CDC, el CDC del documento asociado, montos, razón social,
direcciones y descripción de ítems. Todos sus campos usan
`textAdjust=CUT_TEXT` con anchos pensados para Helvetica; en producción la
fuente es DejaVu (más ancha).

FE-PY usa `api/kude-templates/DE/`, que son esos templates parcheados. **Nunca
apuntar de vuelta a node_modules.**

## Regla

Un KUDE no puede perder un solo carácter de un dato fiscal. Cualquier cambio
en templates, fuentes de la imagen o versión del paquete exige correr la
auditoría con las fuentes de producción y obtener `truncados=0` en los 7
templates.

## Cómo regenerar

```bash
cd api/kude-patch
LIB="../node_modules/facturacionelectronicapy-kude/dist/jasperLibs/*"
javac -cp "$LIB" PatchKude.java Audit.java
for f in ../node_modules/facturacionelectronicapy-kude/dist/DE/*.jasper; do
  java -cp "$LIB:." PatchKude "$f" "../kude-templates/DE/$(basename "$f")"
done
```

`PatchKude` pone `SCALE_FONT` en todo campo dinámico (achica la fuente solo
cuando el contenido no entra; con datos normales el PDF no cambia) y reduce
la fuente de las etiquetas estáticas que Audit marcó. Solo toca atributos de
layout: las expresiones compiladas quedan intactas.

## Cómo auditar (con las fuentes de producción)

```bash
cd api
node kude-patch/gen-worst.cjs /tmp/worst        # XMLs de peor caso, 5 tipos
docker build -t fepy-kude-audit -f kude-patch/Dockerfile.audit kude-patch
(cd kude-patch && javac -cp "../node_modules/facturacionelectronicapy-kude/dist/jasperLibs/*" Audit.java)
docker run --rm \
  -v "$PWD/node_modules/facturacionelectronicapy-kude/dist:/kude:ro" \
  -v "$PWD/kude-templates:/fixed:ro" -v "$PWD/kude-patch:/patch:ro" \
  -v /tmp/worst:/xml:ro fepy-kude-audit sh /patch/audit-all.sh /fixed/DE
```

Auditar en macOS da falsos negativos: las fuentes del sistema son más
angostas que DejaVu.

## Pendiente conocido

`Factura.jasper` y `Factura-Ticket.jasper` declaran `dCantProSer` como
`java.lang.Integer`: una cantidad fraccionaria (12345.5) se imprime 12345.
El tipo del campo está compilado en el evaluador, así que no se arregla con
este parche de layout — requiere recompilar el template.
