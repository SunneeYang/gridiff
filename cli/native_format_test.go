package main

import "testing"

// Expected strings come from the independent SSF 0.11.2 plugin renderer.
// Include boundary values because a generic spreadsheet formatter can silently
// lose the last digit, round negative ties differently or ignore format sections.
func TestNativeNumberFormatCompatibility(t *testing.T) {
	tests := []struct {
		format string
		value  float64
		want   string
	}{
		{"General", 46322.520833333336, "46322.52083"},
		{"General", 1.2345e-7, "1.2345E-07"},
		{"General", 1234567890123, "1.23457E+12"},
		{"0", -2.5, "-2"},
		{"0.00", 1.115, "1.12"},
		{"0", 9007199254740991, "9007199254740991"},
		{"000", -0.25, "-000"},
		{"0.0%", 0.25, "25.0%"},
		{"0.00%", 9007199254740991, "900719925474099100.00%"},
		{"#,##0.00", 9007199254740991, "9,007,199,254,740,991.00"},
		{"#,##0.00", 12345.67, "12,345.67"},
		{"0.00E+00", 0.0001, "1.00E-04"},
		{"##0.0E+0", 0.0001, "100.0E-6"},
		{"##0.0E+0", 12345.67, "12.3E+3"},
		{"# ?/?", 0.25, " 1/4"},
		{"# ??/??", 0.25, "  1/4 "},
		{"# ?/?", 9.999, "10    "},
		{"0.00;[Red](0.00);\"zero\"", 0, "zero"},
		{"0.00;[Red](0.00);\"zero\"", -2.5, "(2.50)"},
		{"0.##", 0, "0."},
		{"0.00\"元\"", -0.0001, "0.00元"},
		{"$#,##0.00", -2.5, "-$2.50"},
		{"[>=1000]0.0,\"k\";0", 12345.67, "12.3k"},
		{"[>=1000]0.0,\"k\";0", 61, "61"},
		{"0,", 12345.67, "12"},
		{"#,##0,,", 1e10, "10,000"},
		{"0.0000000000", -1234567.89, "-1234567.8900000000"},
		{"yyyy-mm-dd", 46322.520833333336, "2026-10-27"},
		{"yyyy-mm-dd", -1, ""},
		{"yyyy-mm-dd", 0.9999999999, "1900-01-01"},
		{"[h]:mm:ss", 1.5, "36:00:00"},
		{"hh:mm:ss.000", 1.2345e-7, "00:00:00.011"},
		{"mmss.0", 0.00001, "0000.9"},
	}
	formatter := nativeNumberFormatter{}
	defer formatter.close()
	for _, tt := range tests {
		actual, err := formatter.format(tt.format, tt.value)
		if err != nil || actual != tt.want {
			t.Errorf("format %q value %v: got %q, want %q (%v)", tt.format, tt.value, actual, tt.want, err)
		}
	}
}

func TestNativeDateFormatCacheStaysBounded(t *testing.T) {
	f := nativeNumberFormatter{}
	defer f.close()
	first, err := f.format("yyyy-mm-dd", 46322)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 1500; i++ {
		if _, err := f.format("yyyy-mm-dd", float64(46000+i)); err != nil {
			t.Fatal(err)
		}
	}
	repeated, err := f.format("yyyy-mm-dd", 46322)
	if err != nil || repeated != first {
		t.Fatal("repeat changed formatted output", repeated, first, err)
	}
	if len(f.cache) > 1024 {
		t.Fatal("unbounded format cache", len(f.cache))
	}
}
