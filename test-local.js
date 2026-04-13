const fs = require('fs');
const path = require('path');
const xmlgen = require('./dist').default;

const params = {
  version: 150,
  ruc: '80069563-1',
  razonSocial: 'DE generado en ambiente de prueba - sin valor comercial ni fiscal',
  nombreFantasia: 'TIPS S.A. TECNOLOGIA Y SERVICIOS',
  actividadesEconomicas: [{ codigo: '1254', descripcion: 'Desarrollo de Software' }],
  timbradoNumero: '12558946',
  timbradoFecha: '2022-08-25',
  tipoContribuyente: 2,
  tipoRegimen: 8,
  establecimientos: [{
    codigo: '001',
    direccion: 'Barrio Carolina',
    numeroCasa: '0',
    complementoDireccion1: 'Entre calle 2',
    complementoDireccion2: 'y Calle 7',
    departamento: 11,
    departamentoDescripcion: 'ALTO PARANA',
    distrito: 145,
    distritoDescripcion: 'CIUDAD DEL ESTE',
    ciudad: 3432,
    ciudadDescripcion: 'PUERTO PTE.STROESSNER (MUNIC)',
    telefono: '0973-527155',
    email: 'tips@tips.com.py',
    denominacion: 'Sucursal 1',
  }],
};

const fixturePath = path.join(__dirname, 'test', 'factura_minimo.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const data = Array.isArray(fixture) ? fixture[0] : fixture;

data.cliente.telefono = '021-555555';
data.cliente.celular = '0981-555555';

(async () => {
  try {
    const xml = await xmlgen.generateXMLDE(params, data);
    const out = path.join(__dirname, 'test-local-output.xml');
    fs.writeFileSync(out, xml);
    console.log('OK  XML generado:', out);
    console.log('    longitud:', xml.length, 'bytes');
    console.log('    preview:');
    console.log(xml.split('\n').slice(0, 6).join('\n'));
  } catch (err) {
    console.error('FAIL', err && err.message ? err.message : err);
    if (err && err.stack) console.error(err.stack);
    process.exit(1);
  }
})();
