import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import {
  aesEcbPaddedSize,
  encryptAesEcb,
  decryptAesEcb,
  parseAesKey,
  buildCdnDownloadUrl,
  mimeFromExt,
  normalizeWechatNewlines,
} from '../lib/channels/wechat.js'

test('AES-128-ECB 加解密往返', () => {
  const key = crypto.randomBytes(16)
  const plaintext = Buffer.from('hello wechat 你好'.repeat(10))
  const ciphertext = encryptAesEcb(plaintext, key)
  assert.notDeepEqual(ciphertext, plaintext)
  const decrypted = decryptAesEcb(ciphertext, key)
  assert.deepEqual(decrypted, plaintext)
})

test('aesEcbPaddedSize PKCS7 填充对齐 16 字节', () => {
  assert.equal(aesEcbPaddedSize(16), 32) // 16 字节明文 → 2 块
  assert.equal(aesEcbPaddedSize(15), 16)
  assert.equal(aesEcbPaddedSize(0), 16)
  assert.equal(aesEcbPaddedSize(100), 112)
})

test('parseAesKey：base64(16 原始字节)', () => {
  const raw = crypto.randomBytes(16)
  const b64 = raw.toString('base64')
  assert.deepEqual(parseAesKey(b64), raw)
})

test('parseAesKey：base64(hex 字符串)', () => {
  const hex = crypto.randomBytes(16).toString('hex')
  const b64 = Buffer.from(hex, 'ascii').toString('base64')
  assert.equal(parseAesKey(b64).toString('hex'), hex)
})

test('parseAesKey：非法输入抛错', () => {
  assert.throws(() => parseAesKey('aGVsbG8='), /无法解析/)
})

test('buildCdnDownloadUrl 正确拼接', () => {
  const url = buildCdnDownloadUrl('a=b&c=d', 'https://novac2c.cdn.weixin.qq.com/c2c')
  assert.equal(url, 'https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=a%3Db%26c%3Dd')
})

test('mimeFromExt 常见类型', () => {
  assert.equal(mimeFromExt('.png'), 'image/png')
  assert.equal(mimeFromExt('.mp4'), 'video/mp4')
  assert.equal(mimeFromExt('.pdf'), 'application/pdf')
  assert.equal(mimeFromExt('.xyz'), 'application/octet-stream')
})

test('CDN aes_key 两种格式都能解密同一密文', () => {
  const rawKey = crypto.randomBytes(16)
  const plaintext = Buffer.from('secret media bytes')
  const ciphertext = encryptAesEcb(plaintext, rawKey)
  // 图片格式：base64(raw)
  const k1 = parseAesKey(rawKey.toString('base64'))
  // 文件格式：base64(hex ascii)
  const k2 = parseAesKey(Buffer.from(rawKey.toString('hex'), 'ascii').toString('base64'))
  assert.deepEqual(decryptAesEcb(ciphertext, k1), plaintext)
  assert.deepEqual(decryptAesEcb(ciphertext, k2), plaintext)
})

test('normalizeWechatNewlines：单换行提升为双换行，空行保持原样', () => {
  assert.equal(normalizeWechatNewlines('题目\n1) 快速\n2) 完整'), '题目\n\n1) 快速\n\n2) 完整')
  // 已有空行不叠加
  assert.equal(normalizeWechatNewlines('提示\n\n题目\n1) 选项'), '提示\n\n题目\n\n1) 选项')
  // 无换行不动
  assert.equal(normalizeWechatNewlines('一行文本'), '一行文本')
  // 连续多个单换行也各自提升
  assert.equal(normalizeWechatNewlines('a\nb\nc'), 'a\n\nb\n\nc')
  // 尾部换行保持
  assert.equal(normalizeWechatNewlines('a\n'), 'a\n')
})
