W = 720; H = 440
load 'theme.gp'
set output 'optimizer-cost-per-node.svg'
set xlabel 'Optimizer iteration' tc rgb '#ffffff'
set ylabel 'Catalog USD per run' tc rgb '#ffffff'
set xrange [0.5:8.5]
set xtics 1,1,8
set yrange [0:0.7]
set key top right
plot 'optimizer-cost-per-node.dat' using 1:($2) with linespoints pt 7 lw 2 lc rgb '#b38cff' title 'C (Agent1)', \
     '' using 1:($3) with linespoints pt 7 lw 2 lc rgb GOLD title 'R1 (Agent2)', \
     '' using 1:($4) with linespoints pt 5 lw 2 dt 2 lc rgb '#e6c568' title 'R2 (Agent1 workers)', \
     '' using 1:($5) with linespoints pt 5 lw 2 dt 3 lc rgb '#cbb568' title 'R3 (Agent2 workers)'
