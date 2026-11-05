load 'theme.gp'
set output 'regex-lib-cdf.svg'
set xlabel 'Latency (ms)' tc rgb '#ffffff'
set ylabel 'Cumulative cases (%)' tc rgb '#ffffff'
set key bottom right
set logscale x 10
set format x '%g'
set xrange [0.01:100]
set yrange [0:100]
set ytics 20
plot 'regex-lib-cdf.dat' using 1:2 with steps lw 2 lc rgb ACCENT title 'sat (90): inclusion fails', \
     '' using 1:3 with steps lw 2 lc rgb GOOD title 'unsat (10): inclusion holds'
