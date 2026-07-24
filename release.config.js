module.exports = {
  branches: ["master"],
  plugins: [
    [
      "@semantic-release/commit-analyzer",
      {
        preset: "conventionalcommits",
        // Keep Conventional Commits semantics, but do not block releases for
        // older/non-conventional messages in the repository history.
        releaseRules: [
          { type: "feat", release: "minor" },
          { type: "fix", release: "patch" },
          { release: "patch" },
        ],
      },
    ],
    "@semantic-release/release-notes-generator",
    "@semantic-release/changelog",
    [
      "@semantic-release/npm",
      {
        npmPublish: false,
      },
    ],
    "@semantic-release/git",
    [
      "@semantic-release/exec",
      {
        prepareCmd:
          "zip -qq -r logseq-ai-auto-tags-${nextRelease.version}.zip dist README.md logo.svg LICENSE package.json",
      },
    ],
    [
      "@semantic-release/github",
      {
        assets: "logseq-ai-auto-tags-*.zip",
      },
    ],
  ],
};
