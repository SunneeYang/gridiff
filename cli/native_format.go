package main

import (
	"math"
	"regexp"
	"strconv"
	"strings"
)

// Numeric compatibility helpers are adapted from SSF 0.11.2 (Copyright
// SheetJS LLC, Apache-2.0). Go implementations keep the display conventions of
// the independently distributed JavaScript extension, including blank padding.
var nativeCondition = regexp.MustCompile(`^\[(<=|>=|<>|=|<|>)(-?[0-9.]+)\]`)
var nativeColor = regexp.MustCompile(`\[(?:Black|Blue|Cyan|Green|Magenta|Red|White|Yellow|Color[0-9]+)\]`)
var nativeDecimal = regexp.MustCompile(`^(#+,##)?(0+)(?:\.([0#]*))?$`)
var nativeFraction = regexp.MustCompile(`^# (\?+)\/(\?+)$`)
var nativeEngineering = regexp.MustCompile(`^#+0\.0E\+0$`)

func nativeSections(format string) []string {
	var result []string
	quoted, escaped, depth, start := false, false, 0, 0
	for i, ch := range format {
		if escaped {
			escaped = false
			continue
		}
		if ch == '\\' {
			escaped = true
			continue
		}
		if ch == '"' {
			quoted = !quoted
			continue
		}
		if quoted {
			continue
		}
		if ch == '[' {
			depth++
		}
		if ch == ']' {
			depth--
		}
		if ch == ';' && depth == 0 {
			result = append(result, format[start:i])
			start = i + 1
		}
	}
	return append(result, format[start:])
}

func nativeSelectFormat(format string, value float64) (string, float64) {
	sections := nativeSections(format)
	conditional := false
	for _, section := range sections {
		if nativeCondition.MatchString(section) {
			conditional = true
			break
		}
	}
	if conditional {
		for index, section := range sections {
			match := nativeCondition.FindStringSubmatch(section)
			if match == nil {
				if index > 0 && value < 0 {
					value = -value
				}
				return nativeColor.ReplaceAllString(section, ""), value
			}
			limit, _ := strconv.ParseFloat(match[2], 64)
			accept := false
			switch match[1] {
			case "<":
				accept = value < limit
			case ">":
				accept = value > limit
			case "<=":
				accept = value <= limit
			case ">=":
				accept = value >= limit
			case "=":
				accept = value == limit
			case "<>":
				accept = value != limit
			}
			if accept {
				return nativeColor.ReplaceAllString(section[len(match[0]):], ""), value
			}
		}
		return "", value
	}
	index := 0
	if value < 0 && len(sections) > 1 {
		index = 1
		value = -value
	} else if value == 0 && len(sections) > 2 {
		index = 2
	}
	return nativeColor.ReplaceAllString(sections[index], ""), value
}

func nativeDecoratedNumber(format string, value float64) (string, bool) {
	format, value = nativeSelectFormat(format, value)
	if text, ok := nativeSimpleNumber(format, value); ok {
		return text, true
	}
	if text, ok := nativeFractionNumber(format, value); ok {
		return text, true
	}
	if nativeEngineering.MatchString(format) {
		return nativeEngineeringNumber(format, value), true
	}
	// Pull literals away from the numeric token. Currency, parentheses, unit
	// suffixes and percent signs do not require a workbook formatting model.
	var prefix, core, suffix strings.Builder
	active, finished, quoted, escaped := false, false, false, false
	for _, ch := range format {
		literal := false
		if escaped {
			literal = true
			escaped = false
		} else if ch == '\\' {
			escaped = true
			continue
		} else if ch == '"' {
			quoted = !quoted
			continue
		} else if quoted {
			literal = true
		}
		placeholder := !literal && strings.ContainsRune("#0,.", ch)
		if placeholder {
			if finished {
				return "", false
			}
			active = true
			core.WriteRune(ch)
		} else {
			if !literal && strings.ContainsRune("[ymdhMsbEe?/", ch) {
				return "", false
			}
			if active {
				finished = true
				suffix.WriteRune(ch)
			} else {
				prefix.WriteRune(ch)
			}
		}
	}
	if !active {
		return prefix.String(), true
	}
	pattern := core.String()
	for strings.HasSuffix(pattern, ",") {
		pattern = strings.TrimSuffix(pattern, ",")
		value /= 1000
	}
	percent := strings.Count(suffix.String(), "%")
	value *= math.Pow10(2 * percent)
	match := nativeDecimal.FindStringSubmatch(pattern)
	if match == nil {
		return "", false
	}
	precision := len(match[3])
	if precision > 15 {
		return "", false
	}
	grouped := match[1] != ""
	abs := value
	if grouped {
		abs = math.Abs(value)
	}
	scale := math.Pow10(precision)
	rounded := nativeJSRound(abs*scale) / scale
	text := nativeNumberString(rounded)
	if strings.Contains(text, "e") {
		return prefix.String() + text + suffix.String(), true
	}
	parts := strings.SplitN(text, ".", 2)
	whole := parts[0]
	if grouped {
		var out strings.Builder
		for i, ch := range whole {
			if i > 0 && (len(whole)-i)%3 == 0 {
				out.WriteByte(',')
			}
			out.WriteRune(ch)
		}
		whole = out.String()
		if value < 0 {
			whole = "-" + whole
		}
	}
	text = whole
	if strings.Contains(pattern, ".") {
		fraction := ""
		if len(parts) == 2 {
			fraction = parts[1]
		}
		minimum := strings.LastIndex(match[3], "0") + 1
		for len(fraction) > minimum && strings.HasSuffix(fraction, "0") {
			fraction = strings.TrimSuffix(fraction, "0")
		}
		if len(fraction) < minimum {
			fraction += strings.Repeat("0", minimum-len(fraction))
		}
		text += "." + fraction
	}
	if prefix.Len() > 0 && strings.HasPrefix(text, "-") {
		return "-" + prefix.String() + strings.TrimPrefix(text, "-") + suffix.String(), true
	}
	return prefix.String() + text + suffix.String(), true
}

var nativeFractionalClock = regexp.MustCompile(`^(h{1,2}:)?(m{1,2})(:?)(s{1,2})\.(0{1,3})$`)

func nativeFractionalTime(format string, value float64) (string, bool) {
	match := nativeFractionalClock.FindStringSubmatch(format)
	if match == nil {
		return "", false
	}
	seconds := (value - math.Floor(value)) * 86400
	whole := int(math.Floor(seconds))
	fraction := seconds - float64(whole)
	if math.Abs(fraction) < 1e-6 {
		fraction = 0
	}
	precision := len(match[5])
	scale := math.Pow10(precision)
	ss := int(nativeJSRound((float64(whole%60) + fraction) * scale))
	if ss >= int(60*scale) {
		ss = 0
	}
	pad := func(value, width int) string {
		text := strconv.Itoa(value)
		return strings.Repeat("0", max(0, width-len(text))) + text
	}
	result := ""
	if match[1] != "" {
		result = pad(whole/3600, len(match[1])-1) + ":"
	}
	result += pad(whole/60%60, len(match[2])) + match[3]
	result += pad(ss/int(scale), len(match[4])) + "." + pad(ss%int(scale), precision)
	return result, true
}

func nativeFractionNumber(format string, value float64) (string, bool) {
	match := nativeFraction.FindStringSubmatch(format)
	if match == nil {
		return "", false
	}
	width := max(len(match[1]), len(match[2]))
	if width > 7 {
		return "", false
	}
	limit := math.Pow10(width) - 1
	x := math.Abs(value)
	b := x
	p2, p1, q2, q1 := float64(0), float64(1), float64(1), float64(0)
	p, q := float64(0), float64(0)
	for q1 < limit {
		a := math.Floor(b)
		p = a*p1 + p2
		q = a*q1 + q2
		if b-a < 0.00000005 {
			break
		}
		b = 1 / (b - a)
		p2, p1 = p1, p
		q2, q1 = q1, q
	}
	if q > limit {
		if q1 > limit {
			q, p = q2, p2
		} else {
			q, p = q1, p1
		}
	}
	whole := math.Floor(p / q)
	numerator := p - whole*q
	base := ""
	if whole != 0 || numerator == 0 {
		base = nativeNumberString(whole)
	}
	sign := ""
	if value < 0 {
		sign = "-"
	}
	if numerator == 0 {
		return sign + base + strings.Repeat(" ", 2*width+2), true
	}
	n, d := nativeNumberString(numerator), nativeNumberString(q)
	return sign + base + " " + strings.Repeat(" ", max(0, width-len(n))) + n + "/" + d + strings.Repeat(" ", max(0, width-len(d))), true
}

func nativeEngineeringNumber(format string, value float64) string {
	if value == 0 {
		return "0.0E+0"
	}
	if value < 0 {
		return "-" + nativeEngineeringNumber(format, -value)
	}
	period := strings.Index(format, ".")
	exponent := int(math.Floor(math.Log10(value)))
	ee := exponent % period
	if ee < 0 {
		ee += period
	}
	text := nativePrecision(value/math.Pow10(ee), 2+ee)
	if !strings.Contains(text, "e") {
		if !strings.Contains(text, ".") {
			length := len(text)
			text = text[:1] + "." + text[1:] + "E+" + strconv.Itoa(exponent-length+ee)
		} else {
			text += "E+" + strconv.Itoa(exponent-ee)
		}
		for strings.HasPrefix(text, "0.") {
			tail := text[2:]
			take := min(period, len(tail))
			text = "0" + tail[:take] + "." + tail[take:]
			text = strings.TrimLeft(text, "0")
			if strings.HasPrefix(text, ".") {
				text = "0" + text
			}
		}
		text = strings.Replace(text, "+-", "-", 1)
	}
	e := strings.IndexAny(text, "eE")
	dot := strings.Index(text, ".")
	if e >= 0 && dot >= 0 && dot < e {
		fraction := text[dot+1 : e]
		text = text[:dot] + fraction[:min(ee, len(fraction))] + "." + fraction[min(ee, len(fraction)):] + "E" + text[e+1:]
	}
	return strings.Replace(text, "e", "E", 1)
}
