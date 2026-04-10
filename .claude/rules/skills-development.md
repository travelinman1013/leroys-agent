---
paths:
  - "**/.hermes/skills/**"
  - "**/skills/**"
---
# Skills Development

## Skill structure
```
~/.hermes/skills/<skill-name>/
  SKILL.md          # Required — main instructions with YAML frontmatter
  references/       # Optional supporting docs
  templates/        # Optional templates
  scripts/          # Optional automation scripts
  assets/           # Optional static files
```

## SKILL.md frontmatter
```yaml
---
name: skill-identifier
description: What this skill does
version: 1.0.0
platforms: [macos, linux]
metadata:
  hermes:
    tags: [category-tags]
    category: devops
    requires_toolsets: [terminal, web]
    config:
      - key: setting.name
        default: "value"
---
```

## Testing workflow
1. Write SKILL.md
2. Test in CLI: `hermes chat` then ask agent to use the skill
3. Verify in gateway only after CLI works
4. Skills auto-register as Discord slash commands (up to 100 limit)

## Cron jobs for skills
```bash
hermes cron add "job-name" --schedule "0 9 * * 1-5" \
  --skill skill-name \
  --message "What to do"
```
Cron notifications go to the Discord home channel.
