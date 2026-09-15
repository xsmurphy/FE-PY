#!/bin/sh
# $1 = dir de templates; XMLs en /xml
LIB="/kude/jasperLibs/*"
for pair in Factura:fe Factura-Ticket:fe NotaCredito:nc NotaDebito:nd NotaDeDebito:nd AutoFactura:af NotaRemision:nr; do
  t=${pair%%:*}; x=${pair##*:}
  java -cp "$LIB:/patch" Audit "$1/$t.jasper" "/xml/$x.xml" 2>&1 | grep -v -i "log4j"
done
