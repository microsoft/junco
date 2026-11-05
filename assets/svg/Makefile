GNUPLOT ?= gnuplot
PLOTS := cooperbench-flash cooperbench-cost optimizer-cost-per-node workload-events lock other regex-lib-cdf

all: $(PLOTS:=.svg)

%.svg: %.gp %.dat theme.gp
	$(GNUPLOT) $<

clean:
	$(RM) $(PLOTS:=.svg)

.PHONY: all clean
