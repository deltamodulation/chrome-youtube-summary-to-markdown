# CLAUDE.md

## Project Structure

- Decision Records: `docs/decisions/` にDR-XXX形式で管理
- Chrome拡張本体: `extension/`

## Release Rules

- プッシュ時は `extension/manifest.json` の `version` のパッチ部分(0.1.x)をインクリメントする
