#!/bin/bash
# GCI Forks - Weekly upstream sync script
# Run: ./sync-all.sh
# Or add to cron: 0 2 * * 0 /c/Users/13464/gci-forks/sync-all.sh

cd /c/Users/13464/gci-forks

for dir in gci-*/; do
  echo "=== Syncing $dir ==="
  cd "$dir"
  
  # Map to upstream
  case "$dir" in
    gci-n8n/) upstream="n8n-io/n8n" ;;
    gci-dify/) upstream="langgenius/dify" ;;
    gci-nocodb/) upstream="nocodb/nocodb" ;;
    gci-windmill/) upstream="windmill-labs/windmill" ;;
    gci-appsmith/) upstream="appsmithorg/appsmith" ;;
  esac
  
  git remote add upstream "https://github.com/$upstream.git" 2>/dev/null || true
  git fetch upstream
  git merge upstream/main --allow-unrelated-histories -m "Sync upstream $(date +%Y-%m-%d)" || echo "Merge conflicts in $dir - manual resolution needed"
  git push origin main
  
  cd ..
done

echo "=== All syncs complete ==="
