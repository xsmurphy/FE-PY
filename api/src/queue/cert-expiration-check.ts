/**
 * Cert expiration check: cron interno que corre cada 24h y detecta
 * certificados de tenant que están por vencer.
 *
 * Por cada cert que vence dentro de CERT_EXPIRATION_WARNING_DAYS:
 *   - Log a nivel WARN con metadata (tenantId, companyId, daysRemaining, fingerprint)
 *   - Pino + Sentry capturan el warning automáticamente
 *
 * Este es el MVP. En Fase 3 agregar:
 *   - Envío de email a la company (requiere SMTP o servicio tipo Resend)
 *   - Webhook al tenant si tiene webhook URL configurada
 *   - Dashboard admin que muestre los certs en rojo/amarillo
 */
import { and, lt, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenantCerts } from '../db/schema.js';
import { env } from '../config/env.js';

let timer: NodeJS.Timeout | null = null;

const checkOnce = async (
  log: (msg: string, extra?: Record<string, unknown>) => void,
): Promise<void> => {
  const warningCutoff = new Date(
    Date.now() + env.CERT_EXPIRATION_WARNING_DAYS * 24 * 60 * 60 * 1000,
  );

  const expiringCerts = await db
    .select({
      certId: tenantCerts.id,
      tenantId: tenantCerts.tenantId,
      companyId: tenantCerts.companyId,
      fingerprint: tenantCerts.fingerprint,
      subjectRuc: tenantCerts.subjectRuc,
      notAfter: tenantCerts.notAfter,
    })
    .from(tenantCerts)
    .where(and(lt(tenantCerts.notAfter, warningCutoff), isNull(tenantCerts.revokedAt)));

  if (expiringCerts.length === 0) {
    log(`[cert-expiration] 0 certs expiring in <= ${env.CERT_EXPIRATION_WARNING_DAYS} days`);
    return;
  }

  log(`[cert-expiration] ${expiringCerts.length} cert(s) expiring soon`, {
    count: expiringCerts.length,
  });

  for (const cert of expiringCerts) {
    const daysRemaining = Math.floor(
      (cert.notAfter.getTime() - Date.now()) / (24 * 60 * 60 * 1000),
    );
    const severity = daysRemaining <= 7 ? 'critical' : daysRemaining <= 15 ? 'high' : 'medium';

    log(`[cert-expiration] ${severity}: cert expires in ${daysRemaining} days`, {
      certId: cert.certId,
      tenantId: cert.tenantId,
      companyId: cert.companyId,
      subjectRuc: cert.subjectRuc,
      fingerprint: cert.fingerprint.slice(0, 16),
      notAfter: cert.notAfter.toISOString(),
      daysRemaining,
      severity,
    });
  }
};

export const startCertExpirationCheck = (
  log: (msg: string, extra?: Record<string, unknown>) => void,
): void => {
  if (timer) return;

  // Primera corrida demorada 60s (después del idempotency GC)
  setTimeout(() => {
    void checkOnce(log).catch((err) =>
      log('[cert-expiration] initial run failed', { err: String(err) }),
    );
  }, 60_000);

  timer = setInterval(() => {
    void checkOnce(log).catch((err) =>
      log('[cert-expiration] run failed', { err: String(err) }),
    );
  }, env.CERT_EXPIRATION_CHECK_INTERVAL_MS);

  timer.unref();
};

export const stopCertExpirationCheck = (): void => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
};
