import { Logger } from '@nestjs/common';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import { Socket, connect } from 'node:net';
import { S3Service } from '../../../../infra/s3/s3.service';

export type ClamdResult =
  | { status: 'OK' }
  | { status: 'FOUND'; signature: string }
  | { status: 'ERROR'; message: string }
  | { status: 'SKIPPED'; reason: 'oversize'; bytes: number };

interface ClamdOptions {
  host: string;
  port: number;
  timeoutMs: number;
  /** Soft per-stream byte budget the INSTREAM transport can carry without dying. */
  maxStreamBytes: number;
  /** Hard byte threshold above which we deliberately skip scanning entirely. */
  hardSkipBytes: number;
}

/**
 * Thin TCP client for ClamAV `clamd`'s INSTREAM protocol. Streams S3 objects
 * straight through to clamd without staging the whole file on disk; aborts
 * with status=ERROR when the object exceeds `maxStreamBytes`.
 *
 * Protocol: each chunk is `<be-uint32 length><bytes>`; an empty `<be-uint32 0>`
 * terminates the stream and clamd replies with `stream: <verdict>`.
 */
export class ClamdClient {
  private readonly logger = new Logger(ClamdClient.name);

  constructor(private readonly s3: S3Service, private readonly opts: ClamdOptions) {}

  async scanS3Object(bucketRole: 'assets' | 'thumbs' | 'editor', key: string): Promise<ClamdResult> {
    const head = await this.s3.headObject(bucketRole, key);
    // Hard skip — these are deliberately not scanned; surface as a benign
    // SKIPPED_SIZE badge instead of an ERROR that pages admins.
    if (head && head.bytes > this.opts.hardSkipBytes) {
      return { status: 'SKIPPED', reason: 'oversize', bytes: head.bytes };
    }
    if (head && head.bytes > this.opts.maxStreamBytes) {
      return { status: 'ERROR', message: `file too large for INSTREAM (${head.bytes} > ${this.opts.maxStreamBytes})` };
    }
    const out = await this.s3.client.send(
      new GetObjectCommand({ Bucket: this.s3.bucketFor(bucketRole), Key: key }),
    );
    if (!out.Body) return { status: 'ERROR', message: 'S3 object has no body' };
    return this.scanStream(out.Body as Readable);
  }

  /** Public for testing — pipes any Readable through clamd. */
  async scanStream(stream: Readable): Promise<ClamdResult> {
    return new Promise<ClamdResult>((resolve, reject) => {
      const socket: Socket = connect({ host: this.opts.host, port: this.opts.port });
      socket.setTimeout(this.opts.timeoutMs);
      const chunks: Buffer[] = [];
      let bytesPiped = 0;

      const fail = (err: Error) => {
        try {
          socket.destroy();
        } catch {
          // ignore
        }
        reject(err);
      };

      socket.on('connect', () => {
        socket.write('zINSTREAM\0');

        stream.on('data', (chunk: Buffer) => {
          bytesPiped += chunk.length;
          if (bytesPiped > this.opts.maxStreamBytes) {
            stream.destroy(new Error('clamd stream exceeded maxStreamBytes'));
            return;
          }
          const len = Buffer.alloc(4);
          len.writeUInt32BE(chunk.length, 0);
          socket.write(len);
          socket.write(chunk);
        });
        stream.on('end', () => {
          const zero = Buffer.alloc(4);
          socket.write(zero);
        });
        stream.on('error', fail);
      });

      socket.on('data', (chunk) => chunks.push(chunk));
      socket.on('end', () => {
        const reply = Buffer.concat(chunks).toString('utf8').replace(/\0/g, '').trim();
        resolve(parseReply(reply));
      });
      socket.on('timeout', () => fail(new Error('clamd timeout')));
      socket.on('error', fail);
    });
  }
}

export function parseReply(reply: string): ClamdResult {
  // Examples:
  //   "stream: OK"
  //   "stream: Eicar-Test-Signature FOUND"
  //   "stream: ERROR Something went wrong"
  if (reply.endsWith('OK')) return { status: 'OK' };
  const foundMatch = reply.match(/^stream:\s+(.+?)\s+FOUND$/);
  if (foundMatch) return { status: 'FOUND', signature: foundMatch[1] };
  const errMatch = reply.match(/ERROR\s*(.*)$/);
  if (errMatch) return { status: 'ERROR', message: errMatch[1].trim() || 'unknown clamd error' };
  return { status: 'ERROR', message: `unparseable clamd reply: ${reply}` };
}
