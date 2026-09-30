import * as fs from 'fs';
import { crc32 } from 'zlib';

/**
 * A zip written straight to disk, one file after another, stored rather than
 * deflated.
 *
 * Audio is already compressed — deflating an MP3 or a FLAC saves next to
 * nothing and costs minutes — and a playlist of AIFFs passes 4 GiB easily, so
 * ZIP64 is written whenever a size or an offset needs it. Each file is opened
 * only while it is being copied: a library of a thousand tracks never holds a
 * thousand descriptors.
 *
 * The CRC is only known once a file has been read, so its local header is
 * written with a zero CRC and patched afterwards. That needs no data
 * descriptor, which some unzip tools still read wrongly under ZIP64.
 */

const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
const UTF8_NAMES = 0x0800;
/** Made by: Unix, spec 4.5 — so the external attributes carry a file mode. */
const MADE_BY = (3 << 8) | 45;

interface Entry {
  name: Buffer;
  crc: number;
  size: number;
  offset: number;
  time: number;
  date: number;
  zip64: boolean;
}

export interface ZipWriterOptions {
  /** Write ZIP64 fields for every entry. For tests: a 4 GiB fixture is not an option. */
  forceZip64?: boolean;
}

/** MS-DOS date and time, which is all a zip header holds. */
function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export class ZipWriter {
  private entries: Entry[] = [];
  private position = 0;

  private constructor(private readonly fd: fs.promises.FileHandle, private readonly options: ZipWriterOptions) {}

  static async create(path: string, options: ZipWriterOptions = {}): Promise<ZipWriter> {
    return new ZipWriter(await fs.promises.open(path, 'w'), options);
  }

  private async write(buffer: Buffer): Promise<void> {
    await this.fd.write(buffer, 0, buffer.length, this.position);
    this.position += buffer.length;
  }

  /**
   * Copy one file in under `name`. `onBytes` hears every chunk; a true
   * `isCancelled()` stops mid-file, and the zip is then only fit for `abort()`.
   */
  async addFile(
    sourcePath: string,
    name: string,
    onBytes: (n: number) => void = () => undefined,
    isCancelled: () => boolean = () => false,
  ): Promise<void> {
    const stat = await fs.promises.stat(sourcePath);
    const nameBuf = Buffer.from(name, 'utf8');
    const offset = this.position;
    const zip64 = !!this.options.forceZip64 || stat.size >= MAX32 || offset >= MAX32;
    const { time, date } = dosDateTime(stat.mtime);

    const extra = zip64 ? Buffer.alloc(20) : Buffer.alloc(0);
    if (zip64) {
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(16, 2);
      extra.writeBigUInt64LE(BigInt(stat.size), 4);
      extra.writeBigUInt64LE(BigInt(stat.size), 12);
    }
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(zip64 ? 45 : 20, 4);
    header.writeUInt16LE(UTF8_NAMES, 6);
    header.writeUInt16LE(0, 8); // stored
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(0, 14); // CRC, patched below
    header.writeUInt32LE(zip64 ? MAX32 : stat.size, 18);
    header.writeUInt32LE(zip64 ? MAX32 : stat.size, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(extra.length, 28);
    await this.write(Buffer.concat([header, nameBuf, extra]));

    let crc = 0;
    let copied = 0;
    const stream = fs.createReadStream(sourcePath, { highWaterMark: 1024 * 1024 });
    try {
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        if (isCancelled()) { throw new ZipCancelled(); }
        crc = crc32(chunk, crc);
        copied += chunk.length;
        await this.write(chunk);
        onBytes(chunk.length);
      }
    } finally {
      stream.destroy();
    }
    // A file that grew or shrank while it was read would leave the header lying.
    if (copied !== stat.size) {
      throw new Error(`${sourcePath} changed size while it was being copied`);
    }

    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32LE(crc >>> 0, 0);
    await this.fd.write(crcBuf, 0, 4, offset + 14);
    this.entries.push({ name: nameBuf, crc: crc >>> 0, size: stat.size, offset, time, date, zip64 });
  }

  /** The central directory and the end records. The zip is complete once this returns. */
  async finish(): Promise<void> {
    const directoryOffset = this.position;
    for (const e of this.entries) {
      const sizeTooBig = e.zip64 || e.size >= MAX32;
      const offsetTooBig = e.zip64 || e.offset >= MAX32;
      const fields: bigint[] = [];
      if (sizeTooBig) { fields.push(BigInt(e.size), BigInt(e.size)); }
      if (offsetTooBig) { fields.push(BigInt(e.offset)); }
      const extra = Buffer.alloc(fields.length ? 4 + fields.length * 8 : 0);
      if (fields.length) {
        extra.writeUInt16LE(0x0001, 0);
        extra.writeUInt16LE(fields.length * 8, 2);
        fields.forEach((v, i) => extra.writeBigUInt64LE(v, 4 + i * 8));
      }
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(MADE_BY, 4);
      header.writeUInt16LE(fields.length ? 45 : 20, 6);
      header.writeUInt16LE(UTF8_NAMES, 8);
      header.writeUInt16LE(0, 10);
      header.writeUInt16LE(e.time, 12);
      header.writeUInt16LE(e.date, 14);
      header.writeUInt32LE(e.crc, 16);
      header.writeUInt32LE(sizeTooBig ? MAX32 : e.size, 20);
      header.writeUInt32LE(sizeTooBig ? MAX32 : e.size, 24);
      header.writeUInt16LE(e.name.length, 28);
      header.writeUInt16LE(extra.length, 30);
      header.writeUInt16LE(0, 32); // comment
      header.writeUInt16LE(0, 34); // disk
      header.writeUInt16LE(0, 36); // internal attributes
      header.writeUInt32LE((0o100644 << 16) >>> 0, 38);
      header.writeUInt32LE(offsetTooBig ? MAX32 : e.offset, 42);
      await this.write(Buffer.concat([header, e.name, extra]));
    }
    const directorySize = this.position - directoryOffset;
    const count = this.entries.length;

    const needsZip64 = !!this.options.forceZip64 || count >= MAX16
      || directoryOffset >= MAX32 || directorySize >= MAX32;
    if (needsZip64) {
      const zip64End = this.position;
      const record = Buffer.alloc(56);
      record.writeUInt32LE(0x06064b50, 0);
      record.writeBigUInt64LE(44n, 4);
      record.writeUInt16LE(MADE_BY, 12);
      record.writeUInt16LE(45, 14);
      record.writeUInt32LE(0, 16);
      record.writeUInt32LE(0, 20);
      record.writeBigUInt64LE(BigInt(count), 24);
      record.writeBigUInt64LE(BigInt(count), 32);
      record.writeBigUInt64LE(BigInt(directorySize), 40);
      record.writeBigUInt64LE(BigInt(directoryOffset), 48);
      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(0x07064b50, 0);
      locator.writeUInt32LE(0, 4);
      locator.writeBigUInt64LE(BigInt(zip64End), 8);
      locator.writeUInt32LE(1, 16);
      await this.write(Buffer.concat([record, locator]));
    }

    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(needsZip64 ? MAX16 : count, 8);
    end.writeUInt16LE(needsZip64 ? MAX16 : count, 10);
    end.writeUInt32LE(needsZip64 ? MAX32 : directorySize, 12);
    end.writeUInt32LE(needsZip64 ? MAX32 : directoryOffset, 16);
    await this.write(end);
    await this.fd.close();
  }

  /** Close without finishing. The caller removes the file. */
  async abort(): Promise<void> {
    await this.fd.close().catch(() => undefined);
  }
}

export class ZipCancelled extends Error {
  constructor() { super('cancelled'); }
}
