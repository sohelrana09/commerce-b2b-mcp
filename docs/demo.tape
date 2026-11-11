# Records docs/images/demo.gif, the README's demo animation.
#
#   brew install vhs        # also installs ttyd and ffmpeg
#   npm install
#   vhs docs/demo.tape
#   gifsicle -O3 --lossy=40 --colors 64 docs/images/demo.gif -o docs/images/demo.gif   # about 2 MB instead of 5
#
# It runs the real demo (`npm run demo`) against the mock store, with no API
# key. The only change from a live run is speed: a hidden helper prints the
# output a line at a time, with a pause before each step, so it can be read.

Output docs/images/demo.gif

Set Shell "bash"
Set FontSize 14
Set Width 1080
Set Height 820
Set Padding 20
Set Framerate 10
Set TypingSpeed 45ms
Set Theme "Dracula"

Hide
Type `export PS1='$ ' NO_UPDATE_NOTIFIER=1 && clear`
Enter
# `script` keeps a terminal attached so the demo's bold and dim text survive the pipe.
Type `npm() { script -q /dev/null npm "$@" | while IFS= read -r l; do case "$l" in *"Step "*|*Next*) sleep 1.2;; esac; printf '%s\n' "$l"; sleep 0.05; done; }; clear`
Enter
Sleep 300ms
Show

Type "npm run -s demo"
Sleep 400ms
Enter
Sleep 14s
