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
    '@semantic-release/npm',
    ['@semantic-release/github', {
      // Release publishing needs contents:write only; do not post PR/issue comments.
      successComment: false,
      failComment: false,
      failTitle: false,
      releasedLabels: false,
    }],
  ],
}
