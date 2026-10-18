# Hero footage

Both clips are free stock video from Mixkit, used under the
[Mixkit License](https://mixkit.co/license/#videoFree) (free for commercial
use, no attribution required, may not be redistributed as stock).

| File | Source | Role |
| --- | --- | --- |
| `hero-call.{mp4,webm}` + `hero-call.jpg` | [Young woman smiling and waving in greeting to people on a live webinar (48680)](https://mixkit.co/free-stock-video/young-woman-smiling-and-waving-in-greeting-to-people-on-48680/) | the Savvy user on a call, full frame |
| `hero-self.{mp4,webm}` | [Happy man chatting by video call on a tablet (41208)](https://mixkit.co/free-stock-video/happy-man-chatting-by-video-call-on-a-tablet-41208/) | self-view tile, top right |

Each take is cut to 8.4 s and made loop-safe by crossfading its last 0.7 s
into its own first frames, so the loop point is continuous. No audio track.

```sh
# 720p source: https://assets.mixkit.co/videos/<id>/<id>-720.mp4
MAIN='[0:v]trim=start=5.0:end=13.4,setpts=PTS-STARTPTS[body];[0:v]trim=start=13.4:end=14.1,setpts=PTS-STARTPTS[tail];[tail][body]xfade=transition=fade:duration=0.7:offset=0,fps=24,scale=960:-2,format=yuv420p[v]'
ffmpeg -i 48680-720.mp4 -filter_complex "$MAIN" -map "[v]" -an -c:v libx264 -preset veryslow -crf 31 -movflags +faststart hero-call.mp4
ffmpeg -i 48680-720.mp4 -filter_complex "$MAIN" -map "[v]" -an -c:v libvpx-vp9 -b:v 0 -crf 42 -row-mt 1 hero-call.webm
ffmpeg -i hero-call.mp4 -frames:v 1 -q:v 4 hero-call.jpg

PIP='[0:v]trim=start=1.0:end=9.4,setpts=PTS-STARTPTS[body];[0:v]trim=start=9.4:end=10.1,setpts=PTS-STARTPTS[tail];[tail][body]xfade=transition=fade:duration=0.7:offset=0,fps=24,scale=320:180,format=yuv420p[v]'
ffmpeg -i 41208-720.mp4 -filter_complex "$PIP" -map "[v]" -an -c:v libx264 -preset slow -crf 29 -movflags +faststart hero-self.mp4
ffmpeg -i 41208-720.mp4 -filter_complex "$PIP" -map "[v]" -an -c:v libvpx-vp9 -b:v 0 -crf 36 -row-mt 1 hero-self.webm
```

To swap the footage, replace these files and keep the names; `Hero.tsx`
references them directly.
