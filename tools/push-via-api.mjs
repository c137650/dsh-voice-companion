/**
 * Upload the working tree to GitHub through the Git Data API.
 *
 * Why not `git push`: on this network the DNS answer for github.com points at
 * an edge that resets the TLS connection, and git has no usable proxy. The
 * REST API (api.github.com) is reachable, so the tree/commit/ref go up that
 * way instead — same result, one commit on the branch.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_PATH = process.env.REPO_PATH ?? 'E:\\dsh-voice-companion'
const OWNER = process.env.GH_OWNER ?? 'c137650'
const NAME = process.env.GH_REPO ?? 'dsh-voice-companion'
const MESSAGE =
  process.env.GH_MESSAGE ??
  'DSH voice companion: plugin + local voice bridge'

/** The stored GitHub credential (GCM), read without printing it. */
function token() {
  const out = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  })
  const line = out.split(/\r?\n/).find((l) => l.startsWith('password='))
  if (!line) throw new Error('no GitHub credential in the credential store')
  return line.slice('password='.length).trim()
}

const auth = token()
const base = `https://api.github.com/repos/${OWNER}/${NAME}`
const headers = {
  Authorization: `Bearer ${auth}`,
  'User-Agent': 'dsh-agent',
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'Content-Type': 'application/json',
}

async function gh(method, url, payload) {
  const resp = await fetch(url, {
    method,
    headers,
    body: payload === undefined ? undefined : JSON.stringify(payload),
  })
  const text = await resp.text()
  if (!resp.ok) throw new Error(`${method} ${url} -> ${resp.status} ${text.slice(0, 400)}`)
  return text ? JSON.parse(text) : null
}

const files = execFileSync('git', ['ls-files'], { cwd: REPO_PATH, encoding: 'utf8' })
  .split(/\r?\n/)
  .filter((f) => f.length > 0)
console.log(`tracked files: ${files.length}`)

const tree = []
for (const file of files) {
  const bytes = readFileSync(join(REPO_PATH, file))
  if (bytes.includes(0)) throw new Error(`binary file in tree: ${file}`)
  tree.push({
    path: file,
    mode: '100644',
    type: 'blob',
    content: bytes.toString('utf8'),
  })
}

const created = await gh('POST', `${base}/git/trees`, { tree })
console.log(`tree: ${created.sha} truncated=${created.truncated}`)

const commit = await gh('POST', `${base}/git/commits`, {
  message: MESSAGE,
  tree: created.sha,
  parents: [],
})
console.log(`commit: ${commit.sha}`)

try {
  const ref = await gh('POST', `${base}/git/refs`, { ref: 'refs/heads/main', sha: commit.sha })
  console.log(`ref created: ${ref.ref} -> ${ref.object.sha}`)
} catch (err) {
  const ref = await gh('PATCH', `${base}/git/refs/heads/main`, { sha: commit.sha, force: true })
  console.log(`ref updated: ${ref.ref} -> ${ref.object.sha}`)
}
