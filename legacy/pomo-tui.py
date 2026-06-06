#!/usr/bin/env python3
"""pomo — anime tamagotchi pomodoro with sync tracking + daily docs."""
import sys, time, os, signal, random, shutil, json, termios, tty, select
from datetime import datetime, date
from pathlib import Path

# ── config ────────────────────────────────────────────
WORK_DEFAULT = 25
BREAK_SHORT  = 5
BREAK_LONG   = 15
CYCLES_PER_SET = 4
LOG_DIR = Path.home() / '.pomo'

# ── colors ────────────────────────────────────────────
PINK   = '\033[38;2;230;80;160m'
INK    = '\033[38;2;10;10;10m'
MID    = '\033[38;2;82;82;91m'
GHOST  = '\033[38;2;153;150;144m'
PAPER  = '\033[38;2;219;214;207m'
ERR    = '\033[38;2;185;28;28m'
MINT   = '\033[38;2;115;191;153m'
AMBER  = '\033[38;2;255;183;77m'
DIM    = '\033[2m'
B      = '\033[1m'
R      = '\033[0m'

# ── terminal ──────────────────────────────────────────
out = sys.stdout.write
flush = sys.stdout.flush
def hide(): out('\033[?25l'); flush()
def show(): out('\033[?25h'); flush()
def at(r, c): out(f'\033[{r};{c}H')
def clr(): out('\033[2J\033[H'); flush()

# ── raw keyboard input ───────────────────────────────
class RawInput:
    def __init__(self):
        self.fd = sys.stdin.fileno()
        self.old = termios.tcgetattr(self.fd)

    def enable(self):
        tty.setcbreak(self.fd)

    def disable(self):
        termios.tcsetattr(self.fd, termios.TCSADRAIN, self.old)

    def get_key(self, timeout=0):
        # timeout=0 → non-blocking poll; >0 → block up to N seconds;
        # None → block until a key arrives (used while paused, ~0 CPU).
        if select.select([sys.stdin], [], [], timeout)[0]:
            ch = sys.stdin.read(1)
            if ch == '\x03': return 'QUIT'   # ctrl-c
            if ch == '\x1b': return None      # ignore escape sequences
            return ch.lower()
        return None

# ── session logging ──────────────────────────────────
def log_event(event_type, start_ts, end_ts, cycle=None, note=None):
    LOG_DIR.mkdir(exist_ok=True)
    log_file = LOG_DIR / f'{date.today().isoformat()}.jsonl'
    entry = {
        'type': event_type,
        'start': datetime.fromtimestamp(start_ts).strftime('%H:%M'),
        'end': datetime.fromtimestamp(end_ts).strftime('%H:%M'),
        'duration_m': round((end_ts - start_ts) / 60, 1),
    }
    if cycle: entry['cycle'] = cycle
    if note:  entry['note'] = note
    with open(log_file, 'a') as f:
        f.write(json.dumps(entry) + '\n')

# ── art collection (from ghostty splash.py) ───────────
# fmt: off
ART_1 = [
    '                                              •●●●◉◉◉◉◉◉◉◉◉◉●●●•',
    '                                         •●◉◉◉●●•••          ••●••●•••',
    '                                      •◉◉◉●•   ••   •••            •••●●•',
    '                                    ●✖◉●  •• ●◉●•    •◉◉     •         •●◉',
    '                                  ●✖◉•   ●✖ •✖         ●✖•   •◉          •✖•',
    '                                 ✖◉     •✖  ✖•          •✖•   ●◉           ✖●',
    '                                ✖●      ✖◉ ●✖            •✖•   ◉◉           ✖•',
    '                               ◉◉       ✖● ✖◉             •✖•   ✖●  ••      ●✖',
    '                              ●✖    ◉•  ✖• ✖◉       •●     •✖   •✖   ✖•      ✖●',
    '                              ✖•   ◉◉  ●✖● ◉✖   ●    ✖◉     ●✖   ✖•  ●✖      •✖',
    '                              ✖   •✖  ●◉✖◉ ✖✖• ●✖●   ✖✖◉     ◉◉  ◉●   ✖•      ✖●',
    '                             •✖   ◉◉ •✖●●✖•✖•✖•◉✖✖●  ✖•●✖•    ✖◉ ●◉   ✖◉      ✖◉',
    '                              ✖•  ✖• ◉◉  ✖✖✖••◉✖◉ ◉◉●◉✖ •✖✖•   ✖●●◉   ◉✖      ◉✖',
    '                              ✖◉●●✖  ✖•◉✖◉◉✖✖● •●   ••●•✖✖✖✖◉●• ●✖●   ●✖  ◉•  ◉✖',
    '                              •✖◉◉✖ •✖●● •✖•◉✖         ●✖•✖✖ •◉✖●◉✖✖• ●✖  ✖•  ◉◉',
    '                               ✖•✖● •✖   ✖✖◉✖✖         ✖✖●✖✖•  •●✖•●• ●✖  ✖•  ✖●',
    '                              ◉✖ ✖●• ✖   ✖✖•✖✖         ✖◉ ✖✖    ●◉    ●✖  ✖● •✖',
    '                             •✖• ✖✖◉✖✖ • •  •   •●●●●●●●●•●•    ◉◉    ●✖  ◉◉ ●✖',
    '                             ◉◉  ✖✖✖◉●●◉◉✖•   •◉●••••••••●◉●    ◉●    ●✖  ●✖ ✖•',
    '                      • •●●  ✖◉●●●•••◉◉••     ◉◉● ••      ●✖    ✖●    ◉✖   ✖✖◉',
    '                    •✖●◉✖• ●•◉◉•●◉✖◉◉✖◉•●•●●  ◉◉●   ✖✖•✖● ◉◉ •●◉✖     ◉◉   ◉✖',
    '                   •✖ ✖• •✖●◉•  ●●•••●●◉◉◉✖◉• ◉◉●   ●✖• ✖ ●✖✖◉•●✖     ✖◉●  •✖',
    '                    ✖●✖ ●✖✖ ◉◉  •●◉●●• ◉●◉••◉●✖◉●     ✖••✖◉◉◉• ◉●   ●•✖●◉   ✖•',
    '                   ◉◉•●✖●●●  ●●◉✖✖     ✖●●•◉◉•●◉◉●●•• ●✖ ◉✖●✖••✖   •✖●✖•✖   ◉◉',
    '                   ✖• ◉•    •✖✖ ✖●•●   ✖◉●●•◉◉◉●••●●●●●◉  ✖●●●✖◉   ◉◉◉● ✖•  ●✖',
    '                   ◉◉•●   •◉● ✖◉✖•●✖   ✖◉ •✖✖●●●•●●••●•    ◉●✖✖   •✖◉✖  ✖●  •✖',
    '             ••●●●●•     ◉◉●●●◉●✖••✖   ●✖•✖◉••◉◉●•●●●•      •✖◉•  ✖●✖◉●●✖•  •✖',
    '        •●●●●●••       ●✖✖●●•   •✖•✖●   ✖◉•   ●✖●••●◉•        •◉◉✖●✖◉  •✖◉  •✖',
    '    •●◉●●•           •◉●         •●✖✖   ◉◉  •●◉◉●●●•            •✖✖◉     ●✖ ●✖',
    '  ●✖●•             •◉◉             ◉✖◉●• ◉◉•◉◉●●●  •●●◉●••••     ●✖       ✖✖✖●',
    ' ◉✖              •◉◉             ●✖◉  ••••●✖         ◉◉◉◉✖✖✖◉•    ✖       ●✖✖',
    '●✖             ●◉●            ◉◉◉✖•                         ✖●    ◉◉      ●✖•',
    '●✖          •●●•       ••●●●✖◉●◉●                          •✖     •✖      ◉◉',
    ' ●●•       •●•  •●●●●●●●●•●✖◉  •●•                         ●✖      ✖•     ✖•',
    '   ••••●●●●●●●●●••       •✖•    •◉             •           ✖●      ◉◉    •✖',
    '                         ✖●       ●●         •◉       •●••●✖       •✖    ✖●',
    '                         ✖•        ••●•      ✖•  •◉●●●•   ●✖       •✖   ●✖',
    '                         ●✖•          ●●◉••••◉◉•••◉●      ✖◉        ✖   ✖●',
    '                          •◉●••        ●◉  ◉◉•✖•  ●● •    ✖◉        ✖● ●✖',
    '                             ••✖◉●●●●●●●●●••    •••••●●●●●✖◉        ✖• ✖•',
    '                               •✖                         ◉✖        ◉ ✖◉',
    '                                ●✖                         ✖●        ◉✖',
    '                                 ●✖                         ✖◉•    •✖◉',
    '                                  •✖●                        •●●●◉●●•',
    '                                    ◉                           •◉',
]
ART_2 = [
    '                            ••••••',
    '                     •●◉◉✖✖✖✖✖✖✖◉◉✖✖✖◉●•',
    '                   •✖✖◉◉✖✖◉◉●●••  •••●◉◉✖✖●',
    '                 •◉✖●●✖◉●••  ••••••••   ••◉✖✖•',
    '              •✖✖◉●•◉✖   •••••• •●●●●•• •• •●✖✖',
    '             ✖✖●•●◉◉✖●◉◉✖✖✖◉◉◉◉◉✖✖✖✖✖✖◉◉●•••  ◉✖●',
    '            ✖✖  •●•◉✖✖●•         •●●◉◉✖✖✖✖● •• •✖✖',
    '           ✖◉  •• ✖✖•                 ●◉◉✖✖✖●•◉●•✖✖',
    '          ✖✖ •◉● ✖✖               •●◉●    ◉✖✖✖◉◉✖✖✖•',
    '         •✖••✖◉•●✖              •◉●• •◉✖✖✖● ◉•●✖ ✖✖✖•',
    '         ◉✖ ✖●  ✖✖              •  •✖✖✖●✖✖     •✖✖✖✖✖✖◉◉◉◉◉◉◉●',
    '         ✖✖✖✖ • ◉✖   •●●••••      •✖◉◉✖✖✖✖✖   ●✖✖●●✖✖◉•     •◉✖✖',
    '         ✖◉✖●••••✖✖ ••••●◉◉◉●         •✖● ●   ✖◉•◉✖●           ●✖◉',
    '         ✖✖✖••••  ✖✖◉•◉✖✖✖✖◉✖✖•              ✖✖◉✖✖✖●             ✖✖',
    '         ✖✖•••• ●✖◉✖✖✖✖✖ •✖✖✖✖✖             ✖✖   •✖✖✖             ◉✖',
    '      •◉✖◉ ••••✖✖✖◉✖•✖◉✖✖● ●●             ●✖●      ✖✖✖•            ●✖✖◉●•',
    '    •✖✖◉•●•••••◉✖◉✖✖●••✖✖✖◉●●•      •  •◉✖✖●        ◉✖✖◉•●✖•        ●✖•●◉◉◉◉●◉◉◉',
    '   ◉✖●  ✖◉••••• ●✖✖        •●◉✖◉●●●◉◉◉◉◉●••●◉●       ●✖●◉◉✖✖●        ●✖    •●•',
    '  ◉✖• •◉✖ •••••• •✖✖◉◉◉◉●●•    ✖✖•✖✖✖                 ✖✖ • •✖◉        ◉✖',
    '  ✖● • ◉✖ •••••••• •••●●◉◉✖✖    ✖  ✖✖●                 ✖•••••✖◉        ✖✖',
    '  ✖✖ •• ✖✖•  ••••••••••   ◉✖    ◉✖ ◉✖✖            ◉    ✖✖ ••• ✖✖        ✖✖',
    '   ✖✖●•• ●✖✖◉• •••••••••• ✖✖     ✖✖●✖✖✖           ✖    ●✖ •••• ✖✖        ✖●',
    '    ●✖✖✖◉• ●◉✖✖•••••••••• ✖✖      ✖✖✖✖✖✖          ◉✖   ●✖ •••   ✖✖  ••   •✖',
    '       •●✖✖• •✖✖•••••• ●● ✖✖      ●✖●✖ ●✖◉•        ●✖● ◉✖ •••●✖✖✖✖✖◉●●    ✖✖',
    ' ●✖✖•    ●✖•••◉✖••••  ●✖● ✖✖       ◉✖✖• •●✖✖◉●•      ✖✖✖✖◉◉✖✖✖✖●           ✖',
    '◉✖●✖✖◉◉◉✖✖●◉✖✖◉•   •●✖✖●• ✖◉        ✖✖✖    •●◉◉✖◉◉●◉✖✖✖✖✖✖✖◉•              ✖•',
    '✖✖  ••●••  ••••◉◉✖✖✖✖●••••✖✖        ◉✖✖✖●•      •●✖✖✖✖✖✖✖✖◉             •●✖◉',
    ' ✖✖✖◉●●●●●●◉◉✖✖◉●●◉◉◉◉✖✖✖◉◉✖•       •✖✖◉✖✖✖✖✖✖✖✖✖✖◉✖✖✖✖✖       •●●◉◉✖✖✖✖✖◉◉◉◉◉',
    '   •●◉◉◉◉◉●●•              ●✖◉•     ●✖✖●•●●◉◉◉◉◉◉●   ✖✖✖✖✖◉•◉◉◉◉◉◉●••',
    '                             ●✖◉◉●◉✖✖✖✖◉           ●●✖✖✖✖✖✖✖✖✖◉',
    '                               ✖✖✖✖✖✖✖◉✖✖◉◉●◉●●●●◉✖●•',
    '                               ●✖✖✖✖✖◉✖✖●✖◉●••●●●',
    '                                •●✖◉●•✖✖◉●',
]
ART_3 = [
    '                               •••●●●●●●●●•••',
    '                           ••●••●••••••••●●●●●••',
    '                         •●●••••  •••••••••••●●●••',
    '                        ●●•     •●•      ••●•••●●••',
    '                       ●●      ●●           •●• ●●•••',
    '                      ●●      •●              •●•●●••',
    '                      ◉•      ◉•                ●•◉•••',
    '                     •◉  ••  •◉          •●●●•● ●••●•••',
    '                     •◉  ◉•  •● ••●       ◉●●◉  ●• ◉•••',
    '                      ◉• ◉•  •◉◉•●●◉•     •◉•●• •● ●●••',
    '                      ●● ●•  •◉  ◉◉●◉            ●●●● •',
    '                      •◉ ●●  •◉●  •             •● ●● •',
    '                      ●● •●  •◉◉•             •●•  ●● •',
    '                     •◉• •◉•  ●●●••     ••●●●••◉   ●• •',
    '                   ••◉•   ●●  •●••●●●●•●◉●•●●•●◉• ●◉•',
    '                  • ●●     ●●  ◉●   •● •     •◉◉•●• ●●',
    '                  ••◉•      ●●••●•   ●        ●●●   •◉',
    '                  ••◉• •    •◉●●•●●• ●•         ●●  •◉',
    '                  ••●◉• ••   ◉• •••  ●●          ●● ●●',
    '                   ••●◉•◉◉•• •◉       ●     ••    ●●●',
    '                    •••●●●•●● •◉      •●     ●•   ◉✖●',
    '                        ••••◉• ◉◉      ●◉    ••  ●✖✖●',
    '                        •••●●•●● ◉     •✖◉◉••◉●●✖✖◉◉•',
    '                      ••••••••●●  ◉•    ●◉●●••●◉•  ●●',
    '                   ••●●•••••       ●•    ●•  •●◉    ◉',
    '                 •●◉◉•              ◉•    ●●●● ●●   ●●',
    '              • •◉✖✖✖●               ◉     ◉●•••◉    ◉•••',
    '             • ●◉●●●●◉•              ●●     ●   •●   ●● •••••',
    '              •◉      ••●•            ●◉    •●   ◉•   ●     •●',
    '              ●•        ••••••••••●●●●• ●    ◉    ◉   ●      •●',
    '              ●●                  ••●••  ●•  •●   •●  ●•      ◉',
    '           •●••●•                      •●•●•  ●●   •●  ●•   •●•',
    '       •••●•    ●●                       ●●◉●  •●•••◉   • •●◉●•●••',
    '     ●••          •••                     ◉•◉    ●●•●•••●●●●●●●●●•',
    '   •◉●    ••••••••  ••••••               •●•◉    •●●●●•••••••••',
    '    •●•••••••••••••••••••••••••••••••   •●•●●•••●•◉•●●•••',
    '                        ••••••••••••••●●• ●●●●●●●●●••••',
    '                               ••••••••    ••••••••••',
]
ART_5 = [
    '                             •••••••••••••••••',
    '                         ••••••••••••••••••••••••••••',
    '                     •••••  •••••••••••••••••••••••••••••',
    '                  ••••  •  •••••••••••••••••••••••••••••••',
    '                •••         •••••••••••••••••••••••••••• •••',
    '               ••   •   •••••••••••••••••••••••••••••••••  ••',
    '             ••        •••   •• ••••••••••••••••••••••••••• ••',
    '            ••        •••   •●• •• •●••••••••••••••••••••••  ••',
    '           ••  ••  • •••    •••  • ••••••••••••••••••••●••••• ●',
    '          ••   •• • ••••   ••••    ••••••••••••••••••••••••••••●',
    '          •   •● • •• •    •• •    • •••••••••••••••••••●••••••••',
    '         ••  ••• •••  •    •• •    •• •••••●••••••••••••●•••••●••',
    '         • • •••  ••  •    ••  ••   •  ●•••●●••••••••••••●••••••••',
    '         • • •••  ••  ••    •   ••  ••• ••••●••••••••••••●••••••••',
    '        •• • •••• ••    ••  ••   •●●●●◉●●●••••••••●••••••••••••●••',
    '         ••• •• •●●●●●●•        •●•••●• •◉●••●••••••••••● •●•••●••',
    '         •••••••●•  ●●•●●           ●●• •●● •●••••••••••● •••••●•••',
    '         • ••••●•  •◉• •◉●          •◉●•●●◉ ••••••●••••● •●•••●•••',
    '         • ••••••   ●◉••●●           ●●  ●● ••••••●•••••••••••●•••',
    '         •• ••• •●   ●• ••                  ●•••••••••••••••••••••',
    '          ••••••●                          •••••••••●•••••••● •••',
    '            ••••●                         ••••••••●••••••●•• ••',
    '             ••••••       ••●●••        ••••••••••••••••••',
    '            •••  •••••  •●●●●●●      ••••••••••••••●•••••',
    '          ••     • •••••●◉●●●●• •  •      •●••••••• •••••',
    '                •••• •••••●●•   ••••      ●•●•••●•   ••••●',
    '               •       •         •      •••••••●•',
    '                        •                  • ••••',
    '                      ••                    •',
    '                     ••                     •',
    '                    •                       •',
    '         •••••     ••                      •',
    '      •••••••••    •                       •',
    '     •••••••••••• •                       •',
    '    •••••••••••••••              •        •',
    '    ●•••••••••••••              •        ••',
    '    •●•••••••••••             ••        ••',
    '      •••••••••••            •• •••••• •●•',
    '         •••••••            ••        •••',
    '           •••●            ••     •• •• •',
    '           • ••          ••         ••  •',
    '            ••          •          ••   •',
    '            •         ••           ●    •',
    '          •          ••             ••   •',
    '         •          •                  • •',
    '        •          •                      ••',
    '       •          •                          ••',
    '      •          ••                             ••',
    '     •          •                                 •••',
    '     •        ••                                     ••',
    '    •        ••                             •        ••●',
    '   •       •• ••••                          •••••••••••●•',
    '   •      ••  ●••••••••••••••••••••••••••••••••••••••●•  •',
    '   •     ••   ●•         ••••••••••••••••••••••••••●•    ••',
    '   •      ••  ●                    •••••••••••••••●•      •',
]
ART_7 = [
    '                                    ••●●●●•••◉●●●●•',
    '                                 •●●•        •• •●●●●••',
    '                              •●●•        •           •◉•',
    '                             ◉◉    ••   •    •   •• ●   ●●',
    '                           •◉•   ••   ••    ●     ● •◉   ●◉',
    '                          ●◉   •◉•   ••    ••     ●  ●●   ●◉',
    '                         ●◉   •◉●    ●     ◉•     ●   ✖    ◉•',
    '                        ◉◉   ●◉••   ●◉    •●•     ◉   ◉•   •◉',
    '                       •✖   •✖  •   ••    ● ●     ✖   ●●    ✖',
    '                       ✖•   ✖  ●✖✖✖✖✖●●   ●  ●••  ●•  ◉●    ✖',
    '                      •✖   ●✖ ◉✖●✖✖●✖◉    •  ✖✖✖✖✖✖●• ✖     ✖',
    '                      ✖•   ◉●◉  ●✖●●✖●      •✖●•✖●◉✖●◉◉  ●  ✖',
    '                      ✖     ◉●  •◉ •✖       ●✖•●✖● ••✖  •◉  ✖',
    '                     ●✖    ●✖                   ●   ✖●  •✖  ✖',
    '                     ✖•     ◉●                     ◉◉    ✖  ✖•',
    '                    ◉●    ◉  ●●●•                 ●✖     ●◉ ✖•',
    '                   •✖     ✖    ●◉✖◉●●••●•••••●●●●••✖      ✖ ●●',
    '                   ●◉ ••  ◉● ◉●•     •◉✖●••••●✖✖   ●●     •✖ ✖',
    '                   •✖ •◉   ●✖•      •●  ✖      ●◉●●•●•     •◉✖•',
    '                    ◉◉ ●●  ◉●      ●●   ●      ◉•    •●● •● •✖●',
    '                     •●●✖  ✖•  • •◉•          •◉       •◉ ✖• •✖',
    '                  •●  ●◉   ◉● ●◉•◉            ●●        ◉✖✖   ●✖',
    '                   ◉●••  ●● ✖✖◉•●             ●•        ◉✖     ✖•',
    '                     ••••●◉◉◉•  •     ••     ●••●      ◉●      ✖',
    '                          ✖•   ••   •●      ●  ✖◉     ✖•   •• ◉•',
    '                         ✖●    ••  ●●     ••   ✖●    ●✖   ◉◉••',
    '                         ◉●     ●  ◉     ••    ✖•     ◉•  ◉●',
    '                          ◉●    •• ●◉  ••      ✖       ✖●••◉•',
    '                           •●✖◉◉●●●●◉●●•      ◉◉      ✖●',
    '                            ●●•●✖●    •●●●●●●•✖•     •✖',
    '                         •●✖◉•●••✖●●•         ✖      ✖',
    '              ••••   •●●●••      ✖  •  •     ◉●     ◉✖◉',
    '        •••●●••  •◉◉●●•          ✖●          ✖      ✖ •✖•',
    '   ●●●•••••     ●●●•             •✖         ◉◉      ✖•• ✖•',
    ' ●◉●        ◉●●◉•                 ●◉• ••••••✖•     ◉◉   •✖',
    ' ✖●       •◉●●•              ••●●●●◉◉●●•••●●✖     •✖     ◉◉',
    '  ◉◉••●●●✖✖             •●●●●●••           •✖     ✖•     •✖',
    '   ●◉●•  ✖           ●●●•                  •✖    •✖      ◉●',
    '        •✖        •◉◉•                     •✖    ✖●      ✖',
    '         ●◉      ●◉•                        ✖    ✖      ✖•',
    '          •●●•••●✖                          ✖•   ●✖   ●◉•',
    '              • ●◉                         ●◉     •◉✖●•',
    '                 ◉◉                       ●✖        •◉●•',
    '                  •●●●••     •••••●●●●●●●●✖• ••     •●◉◉◉◉◉',
    '                      ••••••••••••      ●●••••●◉• ✖◉●●●◉✖✖•',
    '                                                ●◉•◉◉◉●●◉◉',
    '                                                  ●●◉•',
]
ART_9 = [
    '                                     ••●●●••',
    '                                 •●◉◉✖✖✖✖✖✖✖◉•●●●•',
    '                               ●◉✖✖✖✖◉◉◉◉◉◉✖●◉✖✖✖✖◉•',
    '                             •◉✖✖◉◉◉◉✖✖◉◉✖✖◉•◉✖◉◉◉✖◉•',
    '                            •✖✖◉◉✖✖✖✖◉◉✖✖◉●   ●✖◉✖◉✖◉',
    '                            ✖◉◉✖✖◉◉◉◉✖✖◉●      ●✖◉✖◉✖●',
    '                           ●✖◉✖✖✖✖✖✖✖◉•   ●●◉●• ◉✖◉◉◉◉',
    '                           ◉◉✖✖◉✖◉●●◉◉•    •◉●◉ ◉✖◉◉✖◉',
    '                          ◉✖◉✖✖◉◉◉ •◉●●     ●• •✖◉✖◉◉◉',
    '                         ●✖◉✖✖✖✖◉✖• •         •◉◉✖✖✖✖•',
    '                        •✖◉✖✖✖✖✖◉◉●          •●◉◉◉◉◉•',
    '                        ◉◉◉◉◉◉◉◉◉✖✖◉●●•●●●•●●●●◉◉●•',
    '                        ●✖✖✖✖✖✖✖✖◉◉✖✖✖✖●●●●◉◉◉◉◉✖✖◉◉●•',
    '                         •●•●◉◉◉◉◉●•●•••◉◉✖●●◉◉✖✖◉✖✖✖✖◉•',
    '                                       ✖✖◉◉●✖✖✖✖✖✖✖◉◉◉✖✖◉•',
    '                                      ●✖●◉◉●◉◉✖◉✖◉◉◉◉✖◉◉✖✖◉•',
    '                                      ◉●◉◉◉●✖◉✖◉✖●●✖◉✖✖✖◉◉✖✖◉•',
    '                                     •●◉✖◉◉●✖◉✖◉✖●◉✖✖✖✖✖✖✖◉◉✖✖●',
    '                                     ◉●◉✖✖◉●✖◉✖✖◉●✖◉◉✖✖✖✖✖✖✖◉◉✖◉•',
    '                          ••• •●●●●••◉◉●●◉◉●✖◉◉◉◉●◉✖✖✖✖✖✖✖✖✖✖◉◉✖✖●•',
    '                       •●◉◉◉◉◉✖✖✖✖✖✖✖◉◉◉◉● ◉✖◉◉✖•   ◉◉◉✖✖◉◉◉✖✖✖✖✖✖◉•',
    '                    •●◉◉◉●◉◉✖✖◉◉◉◉◉◉◉✖✖✖✖◉●◉◉◉✖◉•●●••◉◉◉◉✖✖✖◉◉◉●•  ●',
    '                 •●◉◉◉◉◉◉✖✖◉◉◉◉✖✖✖◉✖✖✖✖◉◉●●✖◉◉✖●◉✖✖✖✖◉✖◉ ••●●•     ••',
    '              •●◉◉◉◉◉◉✖✖✖◉✖✖✖✖✖◉●  ●◉◉◉✖◉●◉◉◉✖●●✖◉◉◉◉✖◉✖•    ●●     ●',
    '           •●◉◉◉◉◉◉✖✖✖✖✖✖✖◉◉●••    ◉◉◉●••◉✖◉✖◉●✖◉✖✖✖✖✖◉✖•     ◉✖◉●●●●',
    '       ••●◉◉◉◉◉◉✖✖✖✖◉◉●••         ◉◉◉✖• •✖◉◉◉●✖✖✖◉◉◉◉◉✖◉       ◉✖✖✖✖●',
    ' •●●●◉◉◉◉◉◉◉◉◉✖✖◉●●•       •••• ••  ●•  ◉✖✖✖• •●◉✖✖✖✖◉◉•       ●✖◉✖●',
    ' ••●◉◉◉◉◉✖✖✖✖◉✖●          •••• ••• ••  •••◉●     •●◉◉◉•        ◉◉◉●',
    ' •●◉◉◉◉◉◉◉◉◉◉◉◉•               •••••      •           ••••••••••',
    '                               •••••    ••',
]
ART_10 = [
    '                             ••●●●●●●●●••       •••••',
    '                        •●●◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉●••◉◉◉◉◉●●●',
    '                     ●◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉•',
    '                  •●◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉●•',
    '                 ●◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉●',
    '               •◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉•',
    '              •◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉●',
    '             •◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉●◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉●',
    '             ◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉● ●◉◉◉◉◉◉● •◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉•',
    '            ◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉•  ●◉◉◉◉◉◉    ◉◉◉◉◉◉◉◉◉◉◉◉◉◉●',
    '           ●◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉•    ◉◉◉◉◉◉     •◉◉◉◉◉◉◉◉◉◉◉◉◉◉',
    '          ●◉◉◉◉◉◉◉◉◉◉◉◉◉◉✖◉◉●     ●◉◉◉◉●       •◉◉◉◉◉◉◉◉◉◉◉◉◉',
    '        •◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉●   •   •✖◉◉●•         ●◉◉◉◉◉◉◉◉◉◉◉●',
    '      ●◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉●◉●●•     ●◉●•             ◉◉◉◉◉◉◉◉◉◉✖•',
    '   •●◉◉◉◉◉◉◉◉◉◉◉◉◉◉●   ◉✖◉◉◉◉●●       ••••   • • ●◉◉◉◉◉◉◉◉◉◉',
    '  ●◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉✖•   ◉◉•●✖●          •◉✖◉◉◉✖●●• ◉◉◉◉◉◉◉◉◉●',
    ' •✖◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉•                     ◉◉•●✖◉   ●◉◉◉◉◉◉◉◉◉•',
    ' ◉◉◉◉◉◉◉●•◉◉◉◉◉◉◉◉                          •   •✖◉◉◉◉◉◉◉◉◉◉',
    ' •✖◉◉◉◉◉ ●✖◉◉◉◉◉◉◉●          •   •••••           ◉◉◉◉◉◉◉◉◉◉◉●• ••',
    '  ●◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉●        ●•       •◉         ●◉◉◉◉◉◉◉◉◉◉◉◉◉◉●•',
    '    ●◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉●••        ••  •••       •●◉◉◉◉◉◉◉◉◉◉◉',
    '     •◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉●●•              ••●◉◉◉◉◉◉◉◉◉◉◉◉◉✖●',
    ' ◉◉••●◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉●•••••●●◉◉◉◉◉✖✖◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉',
    ' •✖✖◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉●      ◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉',
    '  •●◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉✖◉◉●●        •◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉✖●',
    '   •◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉●●•             ●◉◉◉◉◉◉◉◉◉◉●•◉◉◉◉◉✖◉●',
    '   ◉✖◉◉◉◉◉◉◉◉◉◉●●••◉◉                   •◉◉◉◉◉◉◉●••●◉◉◉◉●',
    '    ◉◉✖◉◉◉◉◉◉●     ◉◉                    ●✖◉◉◉◉       •◉•',
    '      •◉◉◉◉◉●      ◉●                     •●◉◉◉●        ◉●',
    '     ••●◉◉◉◉      •✖•                                    ●◉•',
    '     •●◉◉◉◉◉    ● ●◉                                      •◉◉',
    '          •◉•   •◉◉◉                              •●        •◉●',
    '           ◉●    ◉◉◉◉                            ◉●         •●◉◉◉',
    '           ●●   •◉◉◉◉◉●                         ●◉••   •●●●●•   ●◉',
    '           •◉   ◉◉◉◉◉◉✖◉●                      •✖●●◉◉◉◉●         •◉•',
    '            ◉• ◉◉◉◉◉◉◉◉◉✖◉◉●••   ●◉●••●●●●●◉◉◉◉◉◉◉◉•  •●●•         ◉●',
    '            ●● ●✖◉◉◉◉◉◉◉◉◉◉✖✖✖◉◉◉◉◉✖✖✖✖✖✖✖◉◉◉◉◉◉◉◉◉    •●◉●•       ◉◉',
    '            •◉  ●◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉   ●●•         •◉●',
    '             ◉   ●◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉  ●◉•         ●●●',
    '             ◉•   ◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉◉•●●•        ●●●•',
]
ART_11 = [
    '          ••●◉●●◉◉●●●●•••',
    '     •●●●●●••        ••●◉◉◉●•                                 •●◉◉◉●●•',
    '  •●◉◉●•                  •●◉◉●                           •●◉✖◉●•',
    '•◉●•                          ●•                       •◉✖◉◉●',
    '        ••        •••●●●••                             ●••',
    '    ••●●●•●◉◉◉●●●●●◉◉◉◉●•●◉◉•                                  ●',
    '   •●●●◉◉◉●●●●●•• ●●● •◉◉●••◉●                             •●●◉◉●●••',
    '  •●••●✖●•       •◉  •◉◉✖✖◉• ◉•                        •●◉◉✖◉◉✖✖✖◉◉◉',
    '   ••••◉•●       ◉●••◉✖◉◉◉◉✖◉                        •◉◉◉◉◉◉◉ ●◉••',
    '  ●◉◉●●•  ••••   ✖   •✖✖◉✖✖◉◉●                      ◉✖◉● ◉✖✖✖● ◉',
    '   ••●●◉••◉●•◉●● ●●   •◉◉◉● •◉                     ●✖  ◉●•●●● •✖•',
    '      • •● •●●◉◉• •••      ••◉•                    ◉•   ●●•• ●✖◉',
    '              •●●◉●●●◉◉◉●●●••◉•                   ●●      ••●◉◉',
    '                   •••●●•••••                      ••●●◉◉●●●●•',
]
# fmt: on

COLLECTION = [
    (ART_1,  PINK),
    (ART_2,  PINK),
    (ART_3,  '\033[38;2;60;60;60m'),
    (ART_5,  '\033[38;2;230;80;160m'),
    (ART_7,  PINK),
    (ART_9,  '\033[38;2;30;30;30m'),
    (ART_10, '\033[38;2;40;40;40m'),
    (ART_11, '\033[38;2;20;20;20m'),
]

# ── drawing ───────────────────────────────────────────
def draw_art(art, color, term_w, term_h):
    art_h = len(art)
    art_w = max(len(l) for l in art)
    start_row = max(1, (term_h - art_h - 6) // 2)
    offset_x = max(0, (term_w - art_w) // 2)
    for i, line in enumerate(art):
        r = start_row + i
        if 1 <= r <= term_h - 5:
            at(r, offset_x + 1)
            out(f'{color}{line}{R}')
    flush()
    return start_row + art_h

def draw_timer(mins, secs, label, elapsed, pct, duration, time_color, term_w, bar_row, cycle_info=None):
    # cycle info above time
    if cycle_info:
        at(bar_row, (term_w - len(cycle_info)) // 2)
        out(f'{GHOST}{cycle_info}{R}')

    # time — big and centered (solid colon; no per-tick blink redraw)
    time_str = f'{mins:02d}:{secs:02d}'
    at(bar_row + 1, (term_w - len(time_str)) // 2)
    out(f'{B}{time_color}{time_str}{R}')

    # bar
    bar_w = min(50, term_w - 8)
    filled = pct * bar_w // 100
    empty = bar_w - filled
    bar_x = (term_w - bar_w) // 2
    at(bar_row + 3, bar_x)
    out(f'{B}{INK}{"█" * filled}{PAPER}{"█" * empty}{R}')

    # status line
    e_m = elapsed // 60
    e_s = elapsed % 60
    status = f'{label}  {e_m:02d}:{e_s:02d}/{duration}m'
    pct_str = f'{pct}%'
    at(bar_row + 4, bar_x)
    out(f'{GHOST}{status}{R}')
    at(bar_row + 4, bar_x + bar_w - len(pct_str))
    out(f'{MID}{pct_str}{R}')

    # controls hint
    hint = 's:sync  p:pause  space:skip  q:quit'
    at(bar_row + 6, (term_w - len(hint)) // 2)
    out(f'{DIM}{GHOST}{hint}{R}')

    flush()

def draw_sync(mins, secs, term_w, bar_row):
    time_str = f'{mins:02d}:{secs:02d}'
    at(bar_row + 1, (term_w - len(time_str)) // 2)
    out(f'{B}{AMBER}{time_str}{R}')

    # pulsing indicator
    pulse = '● SYNC' if int(time.time()) % 2 == 0 else '○ SYNC'
    at(bar_row + 3, (term_w - len(pulse)) // 2)
    out(f'{AMBER}{pulse}{R}')

    # hint
    hint = 's:end sync  q:quit'
    at(bar_row + 5, (term_w - len(hint)) // 2)
    out(f'{DIM}{GHOST}{hint}{R}')

    flush()

def get_time_color(pct):
    if pct >= 80: return ERR
    if pct >= 50: return MID
    return INK

def notify(label, dur):
    try:
        os.system(f'osascript -e \'display notification "{label} done · {dur}min" with title "POMO" sound name "Glass"\' 2>/dev/null')
    except: pass
    out('\a'); flush()

# ── phase runners ────────────────────────────────────
def run_countdown(duration, label, raw, cycle_info=None):
    """Countdown timer. Returns ('done'|'sync'|'skip'|'quit', elapsed_s)."""
    total = duration * 60
    start = time.time()
    term_w, term_h = shutil.get_terminal_size()
    art, art_color = random.choice(COLLECTION)

    clr()
    bar_row = draw_art(art, art_color, term_w, term_h)

    paused = False
    pause_acc = 0.0
    pause_start = 0.0
    last_remain = None
    paused_drawn = False

    while True:
        # Block until a keypress OR the next 1s redraw boundary.
        # Paused: nothing counts down, so wait indefinitely for a key (~0 CPU).
        if paused:
            key = raw.get_key(timeout=None)
        else:
            to_next = 1.0 - ((time.time() - start - pause_acc) % 1.0)
            key = raw.get_key(timeout=to_next)

        if key in ('q', 'QUIT'):
            elapsed = int(time.time() - start - pause_acc)
            return 'quit', elapsed
        elif key == 's':
            elapsed = int(time.time() - start - pause_acc)
            return 'sync', elapsed
        elif key in (' ', '\r', '\n'):
            elapsed = int(time.time() - start - pause_acc)
            return 'skip', elapsed
        elif key == 'p':
            paused = not paused
            if paused:
                pause_start = time.time()
                paused_drawn = False
            else:
                pause_acc += time.time() - pause_start
                last_remain = None  # force one redraw on resume

        if paused:
            if not paused_drawn:
                pause_str = '⏸  PAUSED'
                at(bar_row + 1, (term_w - len(pause_str)) // 2)
                out(f'{B}{GHOST}{pause_str}{R}')
                hint = 'p:resume  q:quit'
                at(bar_row + 3, (term_w - len(hint)) // 2)
                out(f'{DIM}{GHOST}{hint}{R}')
                flush()
                paused_drawn = True
            continue

        elapsed = int(time.time() - start - pause_acc)
        if elapsed >= total:
            break

        remain = total - elapsed
        if remain != last_remain:  # repaint only when the visible second changes
            mins = remain // 60
            secs = remain % 60
            pct = min(100, elapsed * 100 // total) if total > 0 else 100
            tc = get_time_color(pct)
            draw_timer(mins, secs, label, elapsed, pct, duration, tc, term_w, bar_row, cycle_info)
            last_remain = remain

    # completed
    draw_timer(0, 0, label, total, 100, duration, MINT, term_w, bar_row, cycle_info)
    notify(label, duration)

    # celebration flash
    for i in range(4):
        c = PINK if i % 2 == 0 else MINT
        draw_art(art, c, term_w, term_h)
        time.sleep(0.35)

    return 'done', total

def run_sync_timer(raw):
    """Count-up sync timer. Returns elapsed seconds."""
    start = time.time()
    term_w, term_h = shutil.get_terminal_size()
    art, art_color = random.choice(COLLECTION)

    clr()
    bar_row = draw_art(art, art_color, term_w, term_h)

    last_elapsed = None
    while True:
        to_next = 1.0 - ((time.time() - start) % 1.0)
        key = raw.get_key(timeout=to_next)
        if key == 's':
            return int(time.time() - start)
        if key in ('q', 'QUIT'):
            return -(int(time.time() - start))  # negative = quit signal

        elapsed = int(time.time() - start)
        if elapsed != last_elapsed:  # repaint only on second change
            mins = elapsed // 60
            secs = elapsed % 60
            draw_sync(mins, secs, term_w, bar_row)
            last_elapsed = elapsed

# ── orchestrator ─────────────────────────────────────
def run_pomodoro(work_min):
    raw = RawInput()
    raw.enable()

    stats = {'work_s': 0, 'break_s': 0, 'sync_s': 0,
             'completed': 0, 'syncs': 0, 'started': time.time()}
    cycle = 0

    try:
        while True:
            cycle += 1
            set_pos = ((cycle - 1) % CYCLES_PER_SET) + 1
            info = f'POMO {set_pos}/{CYCLES_PER_SET}'

            # ── work phase ──
            result, elapsed = run_countdown(work_min, 'WORK', raw, info)
            if result == 'quit':
                log_event('work', time.time() - elapsed, time.time(), cycle=set_pos, note='partial')
                stats['work_s'] += elapsed
                break
            elif result == 'sync':
                log_event('work', time.time() - elapsed, time.time(), cycle=set_pos, note='interrupted')
                stats['work_s'] += elapsed
                sync_s = run_sync_timer(raw)
                if sync_s < 0:
                    log_event('sync', time.time() + sync_s, time.time())
                    stats['sync_s'] += abs(sync_s); stats['syncs'] += 1
                    break
                log_event('sync', time.time() - sync_s, time.time())
                stats['sync_s'] += sync_s; stats['syncs'] += 1
                cycle -= 1  # redo this cycle position
                continue
            elif result == 'skip':
                log_event('work', time.time() - elapsed, time.time(), cycle=set_pos, note='skipped')
                stats['work_s'] += elapsed
            else:  # done
                log_event('work', time.time() - elapsed, time.time(), cycle=set_pos)
                stats['work_s'] += elapsed
                stats['completed'] += 1

            # ── break phase ──
            break_min = BREAK_LONG if set_pos == CYCLES_PER_SET else BREAK_SHORT
            break_label = 'LONG BREAK' if break_min == BREAK_LONG else 'BREAK'

            result, elapsed = run_countdown(break_min, break_label, raw)
            if result == 'quit':
                log_event('break', time.time() - elapsed, time.time(), note='partial')
                stats['break_s'] += elapsed
                break
            elif result == 'sync':
                log_event('break', time.time() - elapsed, time.time(), note='interrupted')
                stats['break_s'] += elapsed
                sync_s = run_sync_timer(raw)
                if sync_s < 0:
                    log_event('sync', time.time() + sync_s, time.time())
                    stats['sync_s'] += abs(sync_s); stats['syncs'] += 1
                    break
                log_event('sync', time.time() - sync_s, time.time())
                stats['sync_s'] += sync_s; stats['syncs'] += 1
            elif result in ('skip', 'done'):
                log_event('break', time.time() - elapsed, time.time())
                stats['break_s'] += elapsed

    finally:
        raw.disable()

    return stats

# ── summary ──────────────────────────────────────────
def show_summary(stats):
    show(); clr()
    total_s = int(time.time() - stats['started'])
    work_m = stats['work_s'] // 60
    break_m = stats['break_s'] // 60
    sync_m = stats['sync_s'] // 60

    print(f'\n  {B}SESSION COMPLETE{R}\n')
    print(f'  {PINK}■{R} {stats["completed"]} pomodoro{"s" if stats["completed"] != 1 else ""}    {work_m}m focused')
    print(f'  {MINT}■{R} breaks       {break_m}m')
    if stats['syncs'] > 0:
        print(f'  {AMBER}■{R} {stats["syncs"]} sync{"s" if stats["syncs"] != 1 else ""}       {sync_m}m')
    print(f'  {GHOST}─────────────────────{R}')
    print(f'  {B}total{R}         {total_s // 60}m\n')

# ── daily report ─────────────────────────────────────
def daily_report(target_date=None):
    d = target_date or date.today().isoformat()
    log_file = LOG_DIR / f'{d}.jsonl'

    if not log_file.exists():
        print(f'\n  {GHOST}no pomo data for {d}{R}\n')
        return

    events = []
    with open(log_file) as f:
        for line in f:
            if line.strip():
                events.append(json.loads(line))

    work_m  = sum(e['duration_m'] for e in events if e['type'] == 'work')
    break_m = sum(e['duration_m'] for e in events if e['type'] == 'break')
    sync_m  = sum(e['duration_m'] for e in events if e['type'] == 'sync')
    completed = len([e for e in events if e['type'] == 'work' and e.get('note') is None])
    sync_count = len([e for e in events if e['type'] == 'sync'])

    print(f'\n  {B}DAILY — {d}{R}\n')
    print(f'  {PINK}■{R} {completed} pomodoro{"s" if completed != 1 else ""}    {work_m:.0f}m focused')
    print(f'  {MINT}■{R} breaks       {break_m:.0f}m')
    if sync_count > 0:
        print(f'  {AMBER}■{R} {sync_count} sync{"s" if sync_count != 1 else ""}       {sync_m:.0f}m')
    print(f'  {GHOST}─────────────────────{R}')
    print(f'  {B}total{R}         {work_m + break_m + sync_m:.0f}m tracked\n')

    # timeline
    print(f'  {B}TIMELINE{R}\n')
    for e in events:
        t = e['type'].upper()
        if t == 'WORK':    color = PINK
        elif t == 'SYNC':  color = AMBER
        else:              color = MINT
        note = f'  ({e["note"]})' if e.get('note') else ''
        print(f'  {GHOST}{e["start"]}–{e["end"]}{R}  {color}{t:10s}{R}  {e["duration_m"]:5.1f}m{GHOST}{note}{R}')
    print()

    # pull ghost sessions
    try:
        import subprocess
        result = subprocess.run(
            ['ghost', 'log', '--format', 'short'],
            capture_output=True, text=True, timeout=5
        )
        if result.stdout.strip():
            print(f'  {B}CLAUDE SESSIONS{R}\n')
            for line in result.stdout.strip().split('\n'):
                print(f'  {GHOST}{line}{R}')
            print()
    except Exception:
        pass

# ── help ─────────────────────────────────────────────
def show_help():
    print(f'''
  {B}pomo{R} — anime tamagotchi pomodoro

  {B}USAGE{R}
    pomo              start (25m default)
    pomo 30           start with 30m work sessions
    pomo log          daily report (today)
    pomo log 2026-04-21   report for specific date

  {B}KEYS{R}
    {B}s{R}     toggle sync mode (count up, no limit)
    {B}p{R}     pause / resume
    {B}space{R} skip to next phase
    {B}q{R}     quit with summary

  {B}CYCLE{R}
    4x work → short break (5m)
    after 4th → long break (15m)
    loops until you quit

  {B}DATA{R}
    sessions logged to ~/.pomo/YYYY-MM-DD.jsonl
''')

# ── main ─────────────────────────────────────────────
def main():
    args = sys.argv[1:]

    if args and args[0] in ('--help', '-h', 'help'):
        show_help()
        return

    if args and args[0] in ('log', 'daily', 'report'):
        target = args[1] if len(args) > 1 else None
        daily_report(target)
        return

    try:
        work_min = int(args[0]) if args else WORK_DEFAULT
    except ValueError:
        show_help()
        return

    def cleanup():
        show()
        try: at(99, 1); out('\n'); flush()
        except: pass

    import atexit
    atexit.register(cleanup)
    hide()

    stats = run_pomodoro(work_min)
    show_summary(stats)

if __name__ == '__main__':
    main()
