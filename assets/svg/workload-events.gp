W = 840; H = 420
load 'theme.gp'
set output 'workload-events.svg'
set style data histograms
set style histogram rowstacked gap 1
set yrange [0:6]
set ytics 1
set ylabel 'Problem events' tc rgb '#ffffff'
set xtics rotate by -35 font ',12'
set bmargin 5
set multiplot layout 1,2
set title 'LlamaIndex' tc rgb '#ffffff'
set key top right
plot 'workload-events.dat' index 0 using 2:xtic(1) title 'Lost update' lc rgb BAD, \
     '' index 0 using 3 title 'Stale state' lc rgb GOLD, \
     '' index 0 using 4 title 'Other' lc rgb MUTED
set title 'Jinja' tc rgb '#ffffff'
unset ylabel
unset key
plot 'workload-events.dat' index 1 using 2:xtic(1) lc rgb BAD, \
     '' index 1 using 3 lc rgb GOLD, \
     '' index 1 using 4 lc rgb MUTED
unset multiplot
