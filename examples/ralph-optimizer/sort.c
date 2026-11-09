/* Bubble-sort optimization target with deterministic randomized tests.
 * Build: cc -O2 -Wall -o sort sort.c
 * ./sort exits 0 with PASS <ms>, or exits 1 with FAIL ...
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

void sort(int *a, size_t n) {
    for (size_t end = n; end > 1; --end) {
        for (size_t i = 1; i < end; ++i) {
            if (a[i - 1] > a[i]) {
                int tmp = a[i - 1];
                a[i - 1] = a[i];
                a[i] = tmp;
            }
        }
    }
}

static int compare(const void *x, const void *y) {
    int a = *(const int *)x;
    int b = *(const int *)y;
    return (a > b) - (a < b);
}

int main(void) {
    static const struct { size_t n; int range; } tests[] = {
        {0, 10}, {1, 10}, {1000, 10}, {10000, 1000000}, {30000, RAND_MAX}
    };
    srand(12345);
    double total_ms = 0;
    for (size_t i = 0; i < sizeof tests / sizeof tests[0]; ++i) {
        size_t n = tests[i].n;
        int range = tests[i].range;
        int *a = malloc((n ? n : 1) * sizeof *a);
        int *expected = malloc((n ? n : 1) * sizeof *expected);
        if (!a || !expected) {
            free(a);
            free(expected);
            fprintf(stderr, "FAIL allocation\n");
            return 1;
        }
        for (size_t j = 0; j < n; ++j) a[j] = rand() % range - range / 2;
        memcpy(expected, a, n * sizeof *a);
        qsort(expected, n, sizeof *expected, compare);
        clock_t start = clock();
        sort(a, n);
        clock_t end = clock();
        total_ms += 1000.0 * (end - start) / CLOCKS_PER_SEC;
        int mismatch = memcmp(a, expected, n * sizeof *a);
        free(a);
        free(expected);
        if (mismatch) {
            printf("FAIL test %zu (n=%zu)\n", i, n);
            return 1;
        }
    }
    printf("PASS %.1f\n", total_ms);
    return 0;
}
