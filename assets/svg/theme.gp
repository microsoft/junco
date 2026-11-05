# Shared look of the README figures: the poster's dark theme (poster.css :root).
if (!exists("W")) W = 720
if (!exists("H")) H = 420
set terminal svg size W,H dynamic noenhanced font 'Segoe UI,14' background '#101827'
set border 3 lc rgb '#8a93a6'
set xtics nomirror textcolor rgb '#ffffff'
set ytics nomirror textcolor rgb '#ffffff'
set key textcolor rgb '#ffffff' Left reverse samplen 2
set style fill solid 0.9 border lc rgb '#101827'
set boxwidth 0.7
ACCENT = '#80c4ff'
MUTED = '#9aa3b5'
GOOD = '#59d499'
BAD = '#ff7b86'
GOLD = '#ffd76e'
