// Minimal QR Code generator — byte mode only, versions 1–10, all ECC levels,
// automatic mask selection. A compact reimplementation of the QR model 2 spec
// (ISO/IEC 18004) following the structure of Project Nayuki's qrcodegen
// (https://www.nayuki.io/page/qr-code-generator-library, MIT); vendored so the
// chair pairing QR adds zero runtime dependencies (CLAUDE.md: no CDN, lean deps).
//
// Capacity/ECC tables below are the published spec values for versions 1–10 —
// enough for a tokened pairing URL (~75 bytes → version 5) with headroom.

export type Ecc = "L" | "M" | "Q" | "H";

const MIN_VERSION = 1;
const MAX_VERSION = 10;

/** Format-information bits per ECC level (spec table: L=1 M=0 Q=3 H=2). */
const ECC_FORMAT_BITS: Record<Ecc, number> = { L: 1, M: 0, Q: 3, H: 2 };

/** ECC codewords PER BLOCK, indexed [ecc][version] (index 0 unused). */
const ECC_CODEWORDS_PER_BLOCK: Record<Ecc, number[]> = {
  L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
  Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24],
  H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28],
};

/** Number of error-correction blocks, indexed [ecc][version] (index 0 unused). */
const NUM_ERROR_CORRECTION_BLOCKS: Record<Ecc, number[]> = {
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
  Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8],
  H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8],
};

const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

/** Raw data modules available in a version-`ver` symbol (excludes function patterns). */
function numRawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

/** Data codeword capacity (bytes) at a version + ECC level. */
function numDataCodewords(ver: number, ecc: Ecc): number {
  return (
    Math.floor(numRawDataModules(ver) / 8) -
    ECC_CODEWORDS_PER_BLOCK[ecc][ver] * NUM_ERROR_CORRECTION_BLOCKS[ecc][ver]
  );
}

// --- GF(256) Reed-Solomon (polynomial 0x11D) ----------------------------------

function rsMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsComputeDivisor(degree: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < degree - 1; i++) result.push(0);
  result.push(1); // the monomial x^0
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = rsMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = rsMultiply(root, 0x02);
  }
  return result;
}

function rsComputeRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result: number[] = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    divisor.forEach((coef, i) => {
      result[i] ^= rsMultiply(coef, factor);
    });
  }
  return result;
}

// --- bit helpers ---------------------------------------------------------------

function getBit(x: number, i: number): boolean {
  return ((x >>> i) & 1) !== 0;
}

// --- the symbol ------------------------------------------------------------------

class QrSymbol {
  readonly size: number;
  readonly modules: boolean[][];
  private readonly isFunction: boolean[][];

  constructor(
    readonly version: number,
    private readonly ecc: Ecc,
  ) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.isFunction = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }

  private setFunctionModule(x: number, y: number, dark: boolean): void {
    this.modules[y][x] = dark;
    this.isFunction[y][x] = true;
  }

  drawFunctionPatterns(): void {
    // timing patterns
    for (let i = 0; i < this.size; i++) {
      this.setFunctionModule(6, i, i % 2 === 0);
      this.setFunctionModule(i, 6, i % 2 === 0);
    }
    // finder patterns + separators (clipped at edges)
    this.drawFinderPattern(3, 3);
    this.drawFinderPattern(this.size - 4, 3);
    this.drawFinderPattern(3, this.size - 4);
    // alignment patterns (skip the three finder corners)
    const alignPos = this.alignmentPatternPositions();
    const n = alignPos.length;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
        this.drawAlignmentPattern(alignPos[i], alignPos[j]);
      }
    }
    // reserve format info (real bits drawn per-mask later) + version info
    this.drawFormatBits(0);
    this.drawVersion();
  }

  private drawFinderPattern(x: number, y: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) {
          this.setFunctionModule(xx, yy, dist !== 2 && dist !== 4);
        }
      }
    }
  }

  private drawAlignmentPattern(x: number, y: number): void {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        this.setFunctionModule(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }

  private alignmentPatternPositions(): number[] {
    if (this.version === 1) return [];
    const numAlign = Math.floor(this.version / 7) + 2;
    const step = Math.ceil((this.version * 4 + 4) / (numAlign * 2 - 2)) * 2;
    const result = [6];
    for (let pos = this.size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
  }

  /** Draw the two copies of the format bits (ECC level + mask, BCH-protected). */
  drawFormatBits(mask: number): void {
    const data = (ECC_FORMAT_BITS[this.ecc] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    // first copy (around the top-left finder)
    for (let i = 0; i <= 5; i++) this.setFunctionModule(8, i, getBit(bits, i));
    this.setFunctionModule(8, 7, getBit(bits, 6));
    this.setFunctionModule(8, 8, getBit(bits, 7));
    this.setFunctionModule(7, 8, getBit(bits, 8));
    for (let i = 9; i < 15; i++) this.setFunctionModule(14 - i, 8, getBit(bits, i));
    // second copy (split along the right and bottom edges)
    for (let i = 0; i < 8; i++) this.setFunctionModule(this.size - 1 - i, 8, getBit(bits, i));
    for (let i = 8; i < 15; i++) this.setFunctionModule(8, this.size - 15 + i, getBit(bits, i));
    this.setFunctionModule(8, this.size - 8, true); // the always-dark module
  }

  /** Draw the two copies of the version bits (versions ≥ 7 only). */
  private drawVersion(): void {
    if (this.version < 7) return;
    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = getBit(bits, i);
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFunctionModule(a, b, bit);
      this.setFunctionModule(b, a, bit);
    }
  }

  /** Interleave data + ECC blocks per the spec, then return the full codeword sequence. */
  addEccAndInterleave(data: readonly number[]): number[] {
    const ver = this.version;
    const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[this.ecc][ver];
    const blockEccLen = ECC_CODEWORDS_PER_BLOCK[this.ecc][ver];
    const rawCodewords = Math.floor(numRawDataModules(ver) / 8);
    const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
    const shortBlockLen = Math.floor(rawCodewords / numBlocks);

    const blocks: number[][] = [];
    const rsDiv = rsComputeDivisor(blockEccLen);
    for (let i = 0, k = 0; i < numBlocks; i++) {
      const datLen = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
      const dat = data.slice(k, k + datLen);
      k += datLen;
      const ecc = rsComputeRemainder(dat, rsDiv);
      const block = dat.slice();
      if (i < numShortBlocks) block.push(0); // placeholder so all blocks are equal length
      blocks.push(block.concat(ecc));
    }

    const result: number[] = [];
    for (let i = 0; i < blocks[0].length; i++) {
      for (let j = 0; j < blocks.length; j++) {
        // skip the placeholder byte in short blocks
        if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(blocks[j][i]);
      }
    }
    return result;
  }

  /** Zigzag-place the codeword bits into the non-function modules. */
  drawCodewords(data: readonly number[]): void {
    let i = 0;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < this.size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? this.size - 1 - vert : vert;
          if (!this.isFunction[y][x] && i < data.length * 8) {
            this.modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7));
            i++;
          }
        }
      }
    }
  }

  /** XOR the mask pattern onto non-function modules (self-inverse). */
  applyMask(mask: number): void {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        let invert: boolean;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        }
        if (invert && !this.isFunction[y][x]) this.modules[y][x] = !this.modules[y][x];
      }
    }
  }

  /** Spec penalty score (rules 1–4) used to pick the best mask. */
  penaltyScore(): number {
    let result = 0;
    const size = this.size;
    // rules 1 + 3, rows and columns
    for (let axis = 0; axis < 2; axis++) {
      for (let i = 0; i < size; i++) {
        const line: boolean[] = [];
        for (let j = 0; j < size; j++) line.push(axis === 0 ? this.modules[i][j] : this.modules[j][i]);
        // rule 1: runs of ≥5 same-colored modules
        let runLen = 1;
        for (let j = 1; j <= size; j++) {
          if (j < size && line[j] === line[j - 1]) {
            runLen++;
            continue;
          }
          if (runLen >= 5) result += PENALTY_N1 + (runLen - 5);
          runLen = 1;
        }
        // rule 3: finder-like 1:1:3:1:1 pattern with a 4-module light flank
        result += PENALTY_N3 * countFinderLike(line);
      }
    }
    // rule 2: 2x2 blocks of same color
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = this.modules[y][x];
        if (c === this.modules[y][x + 1] && c === this.modules[y + 1][x] && c === this.modules[y + 1][x + 1]) {
          result += PENALTY_N2;
        }
      }
    }
    // rule 4: dark-module proportion distance from 50%
    let dark = 0;
    for (const row of this.modules) for (const m of row) if (m) dark++;
    const total = size * size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += k * PENALTY_N4;
    return result;
  }
}

const FINDER_LIKE = [true, false, true, true, true, false, true]; // 1:1:3:1:1

function countFinderLike(line: readonly boolean[]): number {
  let count = 0;
  for (let i = 0; i + FINDER_LIKE.length <= line.length; i++) {
    let match = true;
    for (let j = 0; j < FINDER_LIKE.length; j++) {
      if (line[i + j] !== FINDER_LIKE[j]) {
        match = false;
        break;
      }
    }
    if (!match) continue;
    const lightBefore = i >= 4 && line.slice(i - 4, i).every((m) => !m);
    const end = i + FINDER_LIKE.length;
    const lightAfter = end + 4 <= line.length && line.slice(end, end + 4).every((m) => !m);
    if (lightBefore || lightAfter) count++;
  }
  return count;
}

/**
 * Encode text (UTF-8, byte mode) into a QR module matrix — `matrix[y][x]`,
 * `true` = dark. Picks the smallest version 1–10 that fits and the best mask.
 * Throws when the payload exceeds version 10 capacity (~271 bytes at M).
 */
export function encodeQr(text: string, ecc: Ecc = "M"): boolean[][] {
  const bytes = Array.from(new TextEncoder().encode(text));

  // smallest version that fits: mode(4) + char count(8 or 16) + data bits
  let version = -1;
  let dataUsedBits = 0;
  for (let ver = MIN_VERSION; ver <= MAX_VERSION; ver++) {
    const ccBits = ver <= 9 ? 8 : 16;
    const used = 4 + ccBits + bytes.length * 8;
    if (used <= numDataCodewords(ver, ecc) * 8) {
      version = ver;
      dataUsedBits = used;
      break;
    }
  }
  if (version < 0) throw new Error(`qr: payload too long (${bytes.length} bytes exceeds version ${MAX_VERSION} at ECC ${ecc})`);

  // bit stream: mode + count + data + terminator + padding
  const bits: number[] = [];
  const appendBits = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  appendBits(0x4, 4); // byte mode
  appendBits(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) appendBits(b, 8);
  const capacityBits = numDataCodewords(version, ecc) * 8;
  appendBits(0, Math.min(4, capacityBits - dataUsedBits)); // terminator
  appendBits(0, (8 - (bits.length % 8)) % 8); // byte-align
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) appendBits(pad, 8);

  const dataCodewords: number[] = [];
  bits.forEach((bit, i) => {
    if (i % 8 === 0) dataCodewords.push(0);
    dataCodewords[dataCodewords.length - 1] |= bit << (7 - (i % 8));
  });

  const sym = new QrSymbol(version, ecc);
  sym.drawFunctionPatterns();
  sym.drawCodewords(sym.addEccAndInterleave(dataCodewords));

  // pick the mask with the lowest penalty
  let bestMask = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    sym.applyMask(mask);
    sym.drawFormatBits(mask);
    const score = sym.penaltyScore();
    if (score < bestScore) {
      bestScore = score;
      bestMask = mask;
    }
    sym.applyMask(mask); // undo (XOR is self-inverse)
  }
  sym.applyMask(bestMask);
  sym.drawFormatBits(bestMask);
  return sym.modules;
}
