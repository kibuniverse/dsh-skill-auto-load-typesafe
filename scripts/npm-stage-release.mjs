import { execFile } from 'node:child_process'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'

const require = createRequire(import.meta.url)
const npmCli = resolve(dirname(require.resolve('npm/package.json')), 'bin/npm-cli.js')
const exec = promisify(execFile)
const registry = 'https://registry.npmjs.org/'

async function runNpm(args, { cwd, env, stderr }) {
  try {
    const result = await exec(process.execPath, [npmCli, ...args], {
      cwd, env, maxBuffer: 10 * 1024 * 1024,
    })
    if (result.stderr) stderr.write(result.stderr)
    return result.stdout
  } catch (error) {
    if (error.stderr) stderr.write(error.stderr)
    throw error
  }
}

export async function verifyConditions(_config, context) {
  // Fail before semantic-release creates a tag if the CI OIDC context is absent.
  if (!context.env.ACTIONS_ID_TOKEN_REQUEST_URL || !context.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    throw new Error('npm staging requires GitHub Actions with id-token: write.')
  }
  const version = (await runNpm(['--version'], context)).trim()
  if (version !== '11.20.0') throw new Error(`Expected pinned npm 11.20.0, received ${version}`)
}

export async function publish(_config, context) {
  const { cwd, env, logger, nextRelease: { version, channel } } = context
  const pkg = JSON.parse(await readFile(resolve(cwd, 'package.json'), 'utf8'))
  if (pkg.version !== version) throw new Error('Prepared package version does not match the release.')
  const distTag = channel || 'latest'
  const filename = `${pkg.name.replace(/^@/, '').replaceAll('/', '-')}-${version}.tgz`
  // An absolute tarball path avoids npm interpreting a bare filename as a package spec.
  const tarball = resolve(cwd, '.release', filename)
  const output = await runNpm([
    'stage', 'publish', tarball, '--json', '--ignore-scripts',
    '--registry', registry, '--access', 'public', '--tag', distTag,
  ], context)
  const result = JSON.parse(output)
  const staged = result[pkg.name] ?? result
  if (typeof staged.stageId !== 'string' || !staged.stageId.trim()
      || staged.name !== pkg.name || staged.version !== version) {
    throw new Error('npm did not return a matching package and stageId; check the staging queue before retrying.')
  }
  const receipt = { name: pkg.name, version, distTag, stageId: staged.stageId }
  await writeFile(resolve(cwd, '.release/staging.json'), JSON.stringify(receipt, null, 2) + '\n')
  logger.log('Staged %s@%s (tag %s), stage ID: %s. Awaiting maintainer approval.',
    pkg.name, version, distTag, staged.stageId)
  if (env.GITHUB_STEP_SUMMARY) {
    await appendFile(env.GITHUB_STEP_SUMMARY,
      `## npm package staged — awaiting approval\n\nPackage: ${pkg.name}@${version}\n\nTarget dist-tag: ${distTag}\n\nStage ID: ${staged.stageId}\n\nReview the stage on npmjs.com or with npm stage view, then approve with 2FA. The package is not yet public.\n`)
  }
  return { name: `npm staging (${distTag}; awaiting approval)`, channel: distTag, stageId: staged.stageId }
}
