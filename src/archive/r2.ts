import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { ShardUploader } from "./archive.js";

/**
 * Cloudflare R2 uploader for finished archive shards.
 *
 * R2 rather than S3 because of egress. The archive exists to be replayed --
 * rebuilding the observations table, or re-deriving something the current
 * schema throws away -- and replaying a year of shards out of S3 would cost
 * real money per read, whereas R2 charges nothing for egress. For an archive
 * whose value is entirely in being read back later, that difference outweighs
 * everything else.
 *
 * R2 speaks the S3 API, so this is the standard S3 client pointed at an R2
 * endpoint; switching to S3 needs only a different endpoint and region.
 */
export function createR2Uploader(config: {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}): ShardUploader {
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  return {
    async upload(localPath: string, key: string): Promise<void> {
      // R2 requires a known length for a streamed body.
      const { size } = await stat(localPath);
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: createReadStream(localPath),
          ContentLength: size,
          ContentType: "application/x-ndjson",
          ContentEncoding: key.endsWith(".br") ? "br" : "gzip",
        }),
      );
    },
  };
}
