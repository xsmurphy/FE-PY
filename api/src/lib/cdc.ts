/**
 * Helpers para trabajar con el CDC (Código de Control).
 *
 * Formato: 44 dígitos.
 *   - 2 dígitos: tipoDocumento (01=FE, 04=Autofactura, 05=NC, 06=ND, 07=NR)
 *   - 8 dígitos: RUC emisor (7 + dígito verificador)
 *   - 3 dígitos: establecimiento
 *   - 3 dígitos: punto expedición
 *   - 7 dígitos: número documento
 *   - 1 dígito:  tipo emisión (1=normal, 2=contingencia)
 *   - 4 dígitos: año
 *   - 2 dígitos: mes
 *   - 2 dígitos: día
 *   - 9 dígitos: código seguridad aleatorio
 *   - 3 dígitos: secuencial de mes/año
 *   + 1 dígito dígito verificador del CDC
 *   = 44 total
 *
 * El CDC lo genera `xmlgen` internamente. Esta lib solo lo extrae y valida
 * el formato del XML ya generado.
 */

const CDC_REGEX = /[0-9]{44}/;

/**
 * Extrae el CDC del atributo `Id` del elemento `<DE>` en el XML generado.
 * Ejemplo: `<DE Id="01800695631001001000000122025011510002983981">`
 */
export const extractCdc = (xml: string): string | null => {
  const match = xml.match(/Id="(\d{44})"/);
  return match ? match[1] : null;
};

/**
 * Valida que un string tenga el formato CDC correcto (44 dígitos).
 * No valida el dígito verificador — eso lo hace `xmlgen` al generarlo.
 */
export const isValidCdcFormat = (cdc: string): boolean => {
  return CDC_REGEX.test(cdc) && cdc.length === 44;
};

/**
 * Genera 9 dígitos random para `codigoSeguridadAleatorio` si el cliente no lo provee.
 */
export const generateCodigoSeguridad = (): string => {
  let code = '';
  for (let i = 0; i < 9; i++) {
    code += Math.floor(Math.random() * 10).toString();
  }
  return code;
};
