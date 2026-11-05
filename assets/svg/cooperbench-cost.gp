load 'theme.gp'
set output 'cooperbench-cost.svg'
set bmargin 4.5
set xrange [-0.6:3.6]
set yrange [0:9]
set ylabel 'USD per solved pair' tc rgb '#ffffff'
set xtics ("Junco two-agent\nclaude-sonnet-5" 0, "claude_code\nclaude-sonnet-4-5" 1, "mini_swe_agent_v2\ngpt-5.5" 2, "openhands_sdk\ngpt-5.5" 3)
unset key
plot 'cooperbench-cost.dat' using 0:2:($0 == 0 ? 0x80c4ff : 0x9aa3b5) with boxes lc rgb variable, \
     '' using 0:2:(stringcolumn(3)) with labels offset 0,0.8 tc rgb '#ffffff', \
     '' using 0:(0.35):(sprintf('%s solved, %g min', stringcolumn(4), $5)) with labels tc rgb '#101827' font ',11'
