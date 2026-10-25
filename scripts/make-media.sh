#!/usr/bin/env bash
# Regenerate the end-to-end test videos (needs ffmpeg with libvpx-vp9).
# Every clip is 320×240, 8 s, VP9. Luma levels 16/235 are video black/white.
set -euo pipefail
cd "$(dirname "$0")/../test/e2e/media"

clip() { # name fps luma-expr [cb-expr] [cr-expr]
  ffmpeg -loglevel error -y -f lavfi -i "color=c=black:s=320x240:r=$2:d=8" \
    -vf "format=yuv444p,geq=lum='$3':cb='${4:-128}':cr='${5:-128}'" \
    -c:v libvpx-vp9 -b:v 300k -pix_fmt yuv420p "$1.webm"
  echo "test/e2e/media/$1.webm"
}

clip flash4hz 30 'if(mod(floor(N/4),2),235,16)'           # 3.75 Hz black/white
clip flash12hz 24 'if(mod(N,2),235,16)'                    # 12 Hz: alternate every frame
clip flash15hz 30 'if(mod(N,2),235,16)'                    # 15 Hz
clip redblue12hz 24 'if(mod(N,2),81,41)' 'if(mod(N,2),90,240)' 'if(mod(N,2),240,110)' # saturated red ↔ blue
clip sine6hz60 60 '126+109*sin(2*PI*6*N/60)'               # smooth 6 Hz, small frame-to-frame steps
clip flash2hz 30 'if(mod(floor(N/8),2),235,16)'            # 1.9 Hz: only Maximum hides it
clip flash2-5hz 30 'if(mod(floor(N/6),2),235,16)'          # 2.5 Hz: passes Medium (WCAG), High hides it
clip steady 30 '120+20*sin(N/30)'                          # slow drift, never flashes
