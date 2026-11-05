W = 720; H = 420
load 'theme.gp'
set output 'lock.svg'
set xlabel 'Committed trace length' tc rgb '#ffffff'
set ylabel 'Runtime (ms)' tc rgb '#ffffff'
set key top left
set logscale x 2
set logscale y 10

set format x '%.0f'
set format y '%g'
set xrange [16:65536]
set xtics 16,4,65536
set mxtics 2
grant_color = 0x59d499
deny_color = 0xff7b86
plot 'lock.dat' using 1:2 with linespoints pt 1 dt 1 lc rgb MUTED title 'read', \
     '' using 1:3 with linespoints pt 2 dt 2 lc rgb MUTED title 'edit', \
     '' using 1:4 with linespoints pt 4 dt 3 lc rgb MUTED title 'release', \
     '' using 1:5 with linespoints pt 6 dt 4 lc rgb MUTED title 'remove', \
     '' using 1:2:($6 == 1 ? grant_color : deny_color) with points pt 1 lc rgb variable notitle, \
     '' using 1:3:($7 == 1 ? grant_color : deny_color) with points pt 2 lc rgb variable notitle, \
     '' using 1:4:($8 == 1 ? grant_color : deny_color) with points pt 4 lc rgb variable notitle, \
     '' using 1:5:($9 == 1 ? grant_color : deny_color) with points pt 6 lc rgb variable notitle, \
     keyentry with points pt 7 lc rgb grant_color title 'grant', \
     keyentry with points pt 7 lc rgb deny_color title 'deny'
