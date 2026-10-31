#!/usr/bin/env node
// Publishes every article in articles/ to dev.to through the Forem API.
//
// Each file's dev.to id is kept in articles/.devto.json, so a later run
// updates the same article instead of creating a copy. Without a stored id,
// the script first looks for one of your articles with the same title.
//
//   DEVTO_API_KEY=... node scripts/publish-devto.mjs            publish or update
//   node scripts/publish-devto.mjs --dry-run                    show what would be sent
//
// Relative image paths (../assets/x.png) become raw GitHub URLs, so the same
// Markdown previews on GitHub and renders on dev.to.

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

const API = 'https://dev.to/api'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ARTICLES = join(ROOT, 'articles')
const IDS = join(ARTICLES, '.devto.json')
const REPO = process.env.GITHUB_REPOSITORY ?? 'aashish-g03/claude-mods'
const BRANCH = process.env.GITHUB_REF_NAME ?? 'main'
const RAW = `https://raw.githubusercontent.com/${REPO}/${BRANCH}`
const MAX_TAGS = 4

const isDryRun = process.argv.includes('--dry-run')
const key = process.env.DEVTO_API_KEY

// Front matter is flat `key: value` lines; that is all an article here uses.
function parse(text, file) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) {
    throw new Error(`${file}: no front matter`)
  }
  const meta = {}
  for (const line of match[1].split('\n')) {
    const at = line.indexOf(':')
    if (at > 0) {
      meta[line.slice(0, at).trim()] = line.slice(at + 1).trim()
    }
  }

  return { meta, body: match[2] }
}

// ../assets/x.png, seen from articles/, becomes the file's raw GitHub URL.
const absolute = path => (/^https?:\/\//.test(path) ? path : `${RAW}/${posix.normalize(posix.join('articles', path))}`)

const withAbsoluteImages = body =>
  body.replace(/(!\[[^\]]*\]\()([^)\s]+)(\))/g, (_, open, path, close) => open + absolute(path) + close)

function toArticle(file) {
  const { meta, body } = parse(readFileSync(join(ARTICLES, file), 'utf8'), file)
  const tags = (meta.tags ?? '').split(',').map(tag => tag.trim()).filter(Boolean)
  if (!meta.title) {
    throw new Error(`${file}: front matter has no title`)
  }
  if (tags.length > MAX_TAGS) {
    throw new Error(`${file}: ${tags.length} tags; dev.to takes at most ${MAX_TAGS}`)
  }
  if (tags.some(tag => !/^[a-z0-9]+$/.test(tag))) {
    throw new Error(`${file}: tags must be lowercase letters and digits only: ${tags.join(', ')}`)
  }

  return {
    title: meta.title,
    body_markdown: withAbsoluteImages(body).trim() + '\n',
    published: meta.published === 'true',
    description: meta.description,
    tags,
    main_image: meta.cover_image ? absolute(meta.cover_image) : null,
    canonical_url: meta.canonical_url || null,
    series: meta.series || null,
  }
}

// dev.to answers 429 when called too fast; wait and try again a few times.
async function request(method, path, body) {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(API + path, {
      method,
      headers: { 'api-key': key, 'content-type': 'application/json', accept: 'application/vnd.forem.api-v1+json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (response.status === 429 && attempt < 5) {
      const seconds = Number(response.headers.get('retry-after')) || attempt * 5
      console.log(`  rate limited, waiting ${seconds}s`)
      await new Promise(resolve => setTimeout(resolve, seconds * 1000))
      continue
    }
    if (!response.ok) {
      throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`)
    }

    return response.json()
  }
}

async function findByTitle(title) {
  for (let page = 1; ; page++) {
    const mine = await request('GET', `/articles/me/all?per_page=100&page=${page}`)
    const found = mine.find(article => article.title === title)
    if (found || mine.length < 100) {
      return found
    }
  }
}

const ids = existsSync(IDS) ? JSON.parse(readFileSync(IDS, 'utf8')) : {}
const files = readdirSync(ARTICLES).filter(file => file.endsWith('.md')).sort()
if (!isDryRun && !key) {
  throw new Error('DEVTO_API_KEY is not set')
}

for (const file of files) {
  const article = toArticle(file)
  const state = article.published ? 'published' : 'draft'
  if (isDryRun) {
    const id = ids[file]?.id
    console.log(`${file}: would ${id ? `update #${id}` : 'create'} as ${state}`)
    console.log(JSON.stringify({ ...article, body_markdown: `${article.body_markdown.length} chars` }, null, 2))
    continue
  }
  let id = ids[file]?.id
  if (!id) {
    id = (await findByTitle(article.title))?.id
  }
  const saved = id
    ? await request('PUT', `/articles/${id}`, { article })
    : await request('POST', '/articles', { article })
  ids[file] = { id: saved.id, url: saved.url }
  // Saved after each article, so a later failure can't lose an id and cause a copy.
  writeFileSync(IDS, JSON.stringify(ids, null, 2) + '\n')
  console.log(`${file}: ${id ? 'updated' : 'created'} #${saved.id} as ${state} ${saved.url}`)
}
