load 'theme.gp'
set output 'other.svg'
set style fill solid 0.9 noborder
set ylabel 'Junco speedup (×)' tc rgb '#ffffff'
set key top left
set style data histograms
set style histogram errorbars gap 1 lw 1
set yrange [0:*]
plot 'other.dat' using 2:3:xtic(1) lc rgb ACCENT title 'vs. Dogwood', \
     '' using 4:5 lc rgb GOLD title 'vs. VeriMon'
