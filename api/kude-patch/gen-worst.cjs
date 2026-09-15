// XMLs de peor caso realista para auditar recortes en el KUDE.
const xmlgen = require('facturacionelectronicapy-xmlgen').default;
const fs = require('fs');
const out = process.argv[2];
const params = { version:150, ruc:'80069563-1',
  razonSocial:'DISTRIBUIDORA COMERCIAL E INDUSTRIAL DEL ALTO PARANA SOCIEDAD ANONIMA', nombreFantasia:'DISTRIBUIDORA ALTO PARANA SA',
  actividadesEconomicas:[{codigo:'46900',descripcion:'VENTA AL POR MAYOR NO ESPECIALIZADA DE PRODUCTOS DIVERSOS Y ARTICULOS DE FIESTA'}],
  timbradoNumero:'18260177', timbradoFecha:'2025-08-26', tipoContribuyente:2, tipoRegimen:8,
  establecimientos:[{codigo:'001',denominacion:'CASA MATRIZ',direccion:'AVENIDA MARISCAL FRANCISCO SOLANO LOPEZ ESQUINA DOCTOR EUSEBIO AYALA',numeroCasa:'123456',
    departamento:11,departamentoDescripcion:'ALTO PARANA',distrito:145,distritoDescripcion:'CIUDAD DEL ESTE',ciudad:3383,ciudadDescripcion:'CIUDAD DEL ESTE',
    telefono:'0981123456789',email:'facturacion.electronica@distribuidoraaltoparana.com.py'}]};
const cliente = {contribuyente:true,ruc:'80012345-6',razonSocial:'COOPERATIVA MULTIACTIVA DE PRODUCCION CONSUMO Y SERVICIOS DEL SUR LIMITADA',
  nombreFantasia:'COOPERATIVA DEL SUR',tipoOperacion:1,tipoContribuyente:2,direccion:'RUTA NACIONAL PY01 MARISCAL FRANCISCO SOLANO LOPEZ KILOMETRO 365',
  numeroCasa:'999999',departamento:1,distrito:1,ciudad:1,pais:'PRY',telefono:'0981987654321',email:'administracion.compras@cooperativadelsur.com.py',codigo:'CLI-000123'};
const items = Array.from({length:8},(_,i)=>({codigo:'PROD-'+String(i).padStart(6,'0'),
  descripcion:'GLOBO METALIZADO NUMERO '+i+' DORADO 40 PULGADAS CON VARILLA Y SOPORTE INCLUIDO PARA DECORACION DE EVENTOS INFANTILES',
  unidadMedida:77,cantidad:12345.5,precioUnitario:987654321,ivaTipo:1,ivaBase:100,iva:10}));
const base = { establecimiento:'001', punto:'002', fecha:'2026-09-15T23:59:59', tipoEmision:1, tipoTransaccion:1, tipoImpuesto:1, moneda:'PYG',
  codigoSeguridadAleatorio:'987654321',
  observacion:'Pedido OC-2026-000987 entregado en deposito central. Pago contra entrega segun condiciones comerciales vigentes — Documento generado por Punto — punto.la',
  usuario:{documentoTipo:1,documentoNumero:'4567890',nombre:'MARIA DE LOS ANGELES GONZALEZ BENITEZ',cargo:'ENCARGADA DE FACTURACION'} };
const asociado = {formato:1, cdc:'01035951931001002000061512026090911014423631', tipo:1};
const docs = {
  fe: {...base, tipoDocumento:1, numero:'9999999', cliente, factura:{presencia:1}, condicion:{tipo:2,credito:{tipo:1,plazo:'30 días'}}, items},
  nc: {...base, tipoDocumento:5, numero:'9999998', cliente, notaCreditoDebito:{motivo:2}, documentoAsociado:asociado, items},
  nd: {...base, tipoDocumento:6, numero:'9999997', cliente, notaCreditoDebito:{motivo:1}, documentoAsociado:asociado, items},
  af: {...base, tipoDocumento:4, numero:'9999996', cliente:{...cliente, tipoOperacion:2}, condicion:{tipo:1,entregas:[{tipo:1,monto:'1000',moneda:'PYG'}]},
       autoFactura:{tipoVendedor:1,documentoTipo:1,documentoNumero:'4567890',nombre:'JUAN CARLOS RAMIREZ FERNANDEZ DE LA SANTISIMA TRINIDAD',direccion:'COMPAÑIA SAN ANTONIO CAMINO VECINAL A 5 KILOMETROS DE LA RUTA',numeroCasa:'0',departamento:1,distrito:1,ciudad:1,ubicacion:{lugar:'MERCADO MUNICIPAL',departamento:1,distrito:1,ciudad:1}},
       documentoAsociado:{formato:3,constanciaTipo:1,constanciaNumero:12345678901,constanciaControl:'33445566'},
       items: items.map(i=>({...i,ivaTipo:3,iva:0,ivaBase:0}))},
  nr: {...base, tipoDocumento:7, numero:'9999995', cliente,
       remision:{motivo:1,tipoResponsable:1,kms:999},
       detalleTransporte:{tipo:2,modalidad:1,tipoResponsable:2,inicioEstimadoTranslado:'2026-09-15',finEstimadoTranslado:'2026-09-30',
         salida:{direccion:'AVENIDA MARISCAL FRANCISCO SOLANO LOPEZ ESQUINA DOCTOR EUSEBIO AYALA',numeroCasa:'123456',ciudad:3383,distrito:145,departamento:11},
         entrega:{direccion:'RUTA NACIONAL PY01 MARISCAL FRANCISCO SOLANO LOPEZ KILOMETRO 365',numeroCasa:'999999',ciudad:1,distrito:1,departamento:1},
         vehiculo:{tipo:'CAMION',marca:'MERCEDES',documentoTipo:1,documentoNumero:'AAAB123',numeroMatricula:'AAAB123'},
         transportista:{contribuyente:true,nombre:'TRANSPORTES Y LOGISTICA INTERNACIONAL DEL MERCOSUR SOCIEDAD ANONIMA',ruc:'80099999-1',direccion:'AVENIDA ARTIGAS 4567',
           chofer:{documentoNumero:'4567890',nombre:'PEDRO ANTONIO VILLALBA CACERES',direccion:'BARRIO SAN PABLO'}}},
       items: items.map(({codigo,descripcion,unidadMedida,cantidad})=>({codigo,descripcion,unidadMedida,cantidad}))},
};
(async () => {
  for (const [k, d] of Object.entries(docs)) {
    try { const x = await xmlgen.generateXMLDE(params, d); fs.writeFileSync(`${out}/${k}.xml`, x); console.log('ok', k); }
    catch (e) { console.log('ERR', k, e.message.slice(0, 400)); }
  }
})();
