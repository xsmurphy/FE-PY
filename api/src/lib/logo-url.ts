/**
 * Validación de la URL del logo del contribuyente.
 *
 * El JAR de KUDE DESCARGA esta URL desde el servidor para incrustarla en el
 * PDF — o sea que un integrador podría apuntarla a la red interna y usarnos
 * de proxy (SSRF). Exigimos https y bloqueamos destinos privados.
 */
const PRIVATE_HOST = /^(localhost$|127\.|10\.|192\.168\.|169\.254\.|0\.|\[?::1\]?$|172\.(1[6-9]|2\d|3[01])\.)/i;

export interface LogoUrlCheck {
  valid: boolean;
  error?: string;
}

export const validarLogoUrl = (raw: string): LogoUrlCheck => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { valid: false, error: 'logoUrl no es una URL válida' };
  }
  if (url.protocol !== 'https:') {
    return { valid: false, error: 'logoUrl debe usar https' };
  }
  if (PRIVATE_HOST.test(url.hostname)) {
    return { valid: false, error: 'logoUrl no puede apuntar a una dirección de red privada' };
  }
  if (!/\.(png|jpe?g|gif)$/i.test(url.pathname)) {
    return { valid: false, error: 'logoUrl debe apuntar a una imagen .png, .jpg o .gif' };
  }
  return { valid: true };
};
