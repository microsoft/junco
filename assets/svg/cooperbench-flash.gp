load 'theme.gp'
set output 'cooperbench-flash.svg'
set bmargin 4.5
set xrange [-0.6:2.6]
set yrange [0:50]
set ytics 10
set ylabel 'Solved pairs (of 50)' tc rgb '#ffffff'
set xtics ("Junco\nGPT-6.1 Sol leader, GPT-6 Luna workers" 0, "CooperBench team harness\nCodex, GPT-5.5" 1, "Solo agent\nCodex, GPT-5.5" 2)
unset key
plot 'cooperbench-flash.dat' using 0:2:($0 == 0 ? 0x80c4ff : 0x9aa3b5) with boxes lc rgb variable, \
     '' using 0:2:(sprintf('%d/50', $2)) with labels offset 0,0.8 tc rgb '#ffffff'
