export default {
  branches: [
    'main',
    { name: 'next', channel: 'next', prerelease: 'next' },
    { name: 'beta', channel: 'beta', prerelease: 'beta' },
    { name: 'rc', channel: 'rc', prerelease: 'rc' },
  ],
  tagFormat: 'v${version}',
  plugins: [
    ['@semantic-release/commit-analyzer', { preset: 'conventionalcommits' }],
    ['@semantic-release/release-notes-generator', { preset: 'conventionalcommits' }],
    ['@semantic-release/npm', { npmPublish: false, tarballDir: '.release' }],
    './scripts/npm-stage-release.mjs',
    ['@semantic-release/github', {
      // Release publishing needs contents:write only; do not post PR/issue comments.
      successComment: false,
      failComment: false,
      failTitle: false,
      releasedLabels: false,
      releaseBodyTemplate: '<%= nextRelease.notes %>\n\n### npm staging\n\nThis version has been submitted to npm staging. A maintainer must review and approve it with 2FA before it becomes available on npm. See the Release workflow summary for the stage ID and target dist-tag.',
    }],
  ],
}
