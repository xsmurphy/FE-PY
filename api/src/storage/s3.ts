/**
 * Cliente S3 compatible con MinIO (dev) y DigitalOcean Spaces (prod).
 *
 * La migración entre uno y otro es solo cambio de env vars:
 *   MinIO:  S3_ENDPOINT=http://minio:9000, S3_FORCE_PATH_STYLE=true
 *   Spaces: S3_ENDPOINT=https://nyc3.digitaloceanspaces.com, S3_FORCE_PATH_STYLE=false
 *
 * Todo el código de la app usa SOLO las funciones exportadas (uploadObject,
 * getObject, getPresignedDownloadUrl, etc) — nunca el cliente crudo. Así si
 * mañana migramos a otro proveedor solo hay que cambiar este archivo.
 */
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env.js';

const s3 = new S3Client({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY,
    secretAccessKey: env.S3_SECRET_KEY,
  },
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
});

const BUCKET = env.S3_BUCKET;

export interface UploadOptions {
  contentType?: string;
  metadata?: Record<string, string>;
}

/**
 * Sube un buffer a S3. Devuelve la key del objeto.
 */
export const uploadObject = async (
  key: string,
  body: Buffer | string,
  options: UploadOptions = {},
): Promise<string> => {
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: body,
      ContentType: options.contentType,
      Metadata: options.metadata,
    }),
  );
  return key;
};

/**
 * Descarga un objeto como Buffer.
 */
export const getObject = async (key: string): Promise<Buffer> => {
  const result = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  if (!result.Body) {
    throw new Error(`Object ${key} returned no body`);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of result.Body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};

/**
 * Genera una URL firmada temporal para descargar un objeto.
 * Útil para que los clientes descarguen XMLs/KUDEs sin que pasen por nuestro API.
 *
 * @param expiresInSeconds — default 15 min
 */
export const getPresignedDownloadUrl = async (
  key: string,
  expiresInSeconds = 900,
): Promise<string> => {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), {
    expiresIn: expiresInSeconds,
  });
};

/**
 * Verifica si un objeto existe.
 */
export const objectExists = async (key: string): Promise<boolean> => {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch (err) {
    if (
      typeof err === 'object' &&
      err !== null &&
      '$metadata' in err &&
      (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404
    ) {
      return false;
    }
    throw err;
  }
};

/**
 * Elimina un objeto. Idempotente: no falla si no existe.
 */
export const deleteObject = async (key: string): Promise<void> => {
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
};

/**
 * Builders de keys con convención por tenant — nunca construir keys a mano
 * en el código de negocio.
 */
export const storageKey = {
  xml: (companyId: string, tenantId: string, cdc: string): string =>
    `xml/${companyId}/${tenantId}/${cdc}.xml`,
  kude: (companyId: string, tenantId: string, cdc: string): string =>
    `kude/${companyId}/${tenantId}/${cdc}.pdf`,
  evento: (companyId: string, tenantId: string, eventoId: string): string =>
    `eventos/${companyId}/${tenantId}/${eventoId}.xml`,
} as const;
