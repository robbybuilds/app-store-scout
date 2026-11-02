# Assets

`social-card.png` is the GitHub social preview (Settings → General → Social preview) and the README header. Edit `social-card.html`, then render:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --hide-scrollbars \
  --force-device-scale-factor=1 --window-size=1280,640 \
  --screenshot="$PWD/social-card.png" "file://$PWD/social-card.html"
```
