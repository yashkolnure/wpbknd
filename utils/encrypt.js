import crypto from 'crypto';
import dotenv from 'dotenv';
dotenv.config();

if (!process.env.ENCRYPTION_KEY) {
  throw new Error('ENCRYPTION_KEY is not set in .env');
}

const ALGO   = 'aes-256-cbc';
const KEY    = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
const IV_LEN = 16;

export const encrypt = (text) => {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  const encrypted = Buffer.concat([cipher.update(text), cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
};

export const decrypt = (text) => {
  const [ivHex, encHex] = text.split(':');
  const iv        = Buffer.from(ivHex, 'hex');
  const encrypted = Buffer.from(encHex, 'hex');
  const decipher  = crypto.createDecipheriv(ALGO, KEY, iv);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString();
};