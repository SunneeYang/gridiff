package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"math/rand"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestNativeCSVRecordsAndErrors(t *testing.T) {
	for _, fixture := range []struct {
		text string
		want [][]string
	}{
		{"\ufeffid,text\r\n001,\"a,b\r\n\"\"q\"\"\"\r\n002,", [][]string{{"id", "text"}, {"001", "a,b\r\n\"q\""}, {"002", ""}}},
		{"", [][]string{}}, {"a,b\n", [][]string{{"a", "b"}}}, {`""`, [][]string{{""}}},
		{"\n\r\n", [][]string{{""}, {""}}}, {",", [][]string{{"", ""}}},
	} {
		got, err := parseCSVRows(fixture.text)
		if err != nil || !reflect.DeepEqual(got, fixture.want) {
			t.Fatalf("%q: %#v, %v; want %#v", fixture.text, got, err, fixture.want)
		}
	}
	for _, text := range []string{`a,"unfinished`, `a,b"c`, `a,"b"oops`} {
		if _, err := parseCSVRows(text); err == nil || !strings.Contains(err.Error(), "引号") {
			t.Fatalf("invalid CSV accepted: %q", text)
		}
	}
}

type nativeParityFixture struct {
	Name     string             `json:"name"`
	Before   string             `json:"before"`
	After    string             `json:"after"`
	Rows     [][][]string       `json:"rows,omitempty"`
	Metadata [][][]cellMetadata `json:"metadata,omitempty"`
	Options  tableOptions       `json:"options,omitempty"`
	States   []viewState        `json:"states"`
}

type nativeParityResult struct {
	Model *diffModel         `json:"model,omitempty"`
	Error string             `json:"error,omitempty"`
	Views []nativeParityView `json:"views,omitempty"`
}

type nativeParityView struct {
	Rows     []diffRow `json:"rows"`
	PageInfo pageInfo  `json:"pageInfo"`
}

func evaluateNativeFixture(f nativeParityFixture) nativeParityResult {
	tables := [2]*tableData{}
	for i, text := range []string{f.Before, f.After} {
		rows, err := parseCSVRows(text)
		if f.Rows != nil {
			rows, err = f.Rows[i], nil
		}
		if err != nil {
			return nativeParityResult{Error: err.Error()}
		}
		var metadata [][]cellMetadata
		if f.Metadata != nil {
			metadata = f.Metadata[i]
		}
		tables[i], err = prepareTable(rows, metadata, f.Options)
		if err != nil {
			return nativeParityResult{Error: err.Error()}
		}
	}
	model, err := compareNativeTables(tables[0], tables[1], f.Options)
	if err != nil {
		return nativeParityResult{Error: err.Error()}
	}
	result := nativeParityResult{Model: model}
	for _, state := range f.States {
		rows, info := selectNativeView(model, state)
		result.Views = append(result.Views, nativeParityView{rows, info})
	}
	return result
}

// Keep a differential check against the independent plugin engine. It catches
// key/ordering/selection regressions without duplicating expectations in Go.
func TestNativeTableAndViewMatchJavaScript(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node is unavailable; differential plugin comparison skipped")
	}
	states := []viewState{{OnlyFields: true}, {OnlyFields: true, OnlyChanges: true}, {OnlyFields: true, Query: "name204", Page: 99}, {OnlyFields: false, Page: 99}, {Query: "TRUE"}, {Query: "9007199"}, {Query: "<>&"}, {Page: -5}, {Query: "i\u0307"}, {Query: "ος"}}
	fixtures := []nativeParityFixture{
		{Name: "empty"},
		{Name: "empty separators", Before: "id,name,x\n1,A\n,,\n\n2,B,", After: "id,name,x\n1,A,,\n2,C"},
		{Name: "broken quotes", Before: "id,name\n1,\"oops"},
		{Name: "overwide", Before: "id,name\n1,A,not-empty"},
		{Name: "headerless", Before: "all,EZone,Home,地区,1\nall,EZone,World,世界,2", After: "all,EZone,World,世界,3", Options: tableOptions{"format": "headerless", "alignment": "position"}},
		{Name: "custom", Before: "Report\nid,name\n编号,名称\n001,A", After: "Report\nid,name\n编号,名字\n001,B", Options: tableOptions{"format": "custom", "headerRow": 2, "descriptionRow": 3, "dataStartRow": 4}},
		{Name: "invalid custom", Before: "id,v\n1,2", Options: tableOptions{"format": "custom", "headerRow": 2, "dataStartRow": 2}},
		{Name: "missing custom", Before: "id,v\n1,2", Options: tableOptions{"format": "custom", "headerRow": 3, "dataStartRow": 4}},
		{Name: "invalid format", Before: "id,v\n1,2", Options: tableOptions{"format": "no"}},
		{Name: "duplicate field", Before: "id,id\n1,2"},
		{Name: "empty field", Before: "id,\n1,2"},
		{Name: "duplicate key", Before: "id,v\n1,a\n1,b"},
		{Name: "missing key", Before: "id,v\n,a"},
		{Name: "missing key column", Before: "id,v\n1,a", After: "other,v\n1,a", Options: tableOptions{"keyColumns": []string{"id"}}},
		{Name: "duplicate key column", Before: "id,v\n1,a", Options: tableOptions{"keyColumns": []string{"id", "id"}}},
		{Name: "composite key", Before: "a,b,v\nx,y|z,1\nx|y,z,2", After: "a,b,v\nx,y|z,3\nx|y,z,2", Options: tableOptions{"keyColumns": []string{"a", "b"}}},
		{Name: "field removal", Before: "id,v\n1,", After: "id\n1"},
		{Name: "only headers", Before: "id,v", After: "id,v"},
		{Name: "raw strings", Before: "id,v\n0001,9007199254740993\n0002,0\n0003,<script>oops</script>", After: "id,v\n0001,9007199254740994\n0002,\n0003, <script>oops</script>"},
		{Name: "HTML and separators in identity", Before: "id,v\n<>&\u2028\u2029,a\n\\u2028,b", After: "id,v\n<>&\u2028\u2029,c\n\\u2028,b"},
		{Name: "Unicode case search", Before: "id,v\n1,İSTANBUL\n2,ΟΣ\n3,ΟΣΑ\n4,Ο'Σ", After: "id,v\n1,İSTANBUL\n2,ΟΣ\n3,ΟΣΑ\n4,Ο'Σ"},
		{Name: "Unicode field detection", Before: "all,all\nint32,string\nİD,v\n编号,值\n1,a", After: "all,all\nint32,string\nİD,v\n编号,值\n1,a"},
		{Name: "reordered fields", Before: "id,a,b\n001,x,y\n002,z,w", After: "b,id,a\nw,002,z\ny,001,changed"},
		{Name: "added removed fields", Before: "id,a,b\n1,x,y\n2,z,w", After: "new,id,b\nv,0,x\nv,1,y\nv,2,w"},
		{Name: "vertical enums", Before: "all,int32,None,无,0\nall,int32,All,所有单位,1\nall,int32,Near_1,最近的1个单位,10", After: "all,int32,None,无,0\ngo,int64,All,全部单位,2\nall,int32,Near_2,最近的2个单位,11"},
		{Name: "vertical aliases", Before: "\nall,EFightCondition,type,类型\n\nall,Array（int32）,value,值", After: "\nall,EFightCondition,type,类型\n\nall,Array（int32）,value,值2"},
		{Name: "vertical disabled and nameless", Before: "all,int32,A,说明,1,尾注\nCOST_MUL,,Disabled,停用,14232\nall,string,,无名称,原文", After: "all,int32,A,说明,1,新尾注\nCOST_MUL,,Disabled,停用,14232\nall,string,,无名称,新文"},
		{Name: "added modified column union", Before: "id,a,b,empty\n1,old,stay,\n2,delete,only-deleted,", After: "id,a,b,empty\n1,new,stay,\n3,added,,"},
		{Name: "removed only column union", Before: "id,a,b,empty\n1,old,stay,\n2,delete,only-deleted,"},
	}
	for _, kind := range []string{"长整数", "整数数组", "文本Map", "array（string）", "Map(int32)", "uint64", "range"} {
		fixtures = append(fixtures, nativeParityFixture{Name: "vertical type " + kind, Before: `"all,i18n",` + kind + `,Title,标题,001`, After: `"all,i18n",` + kind + `,Title,标题,002`})
	}
	header := "ts,none,ts\nint32,string,string\nid,name,effect\n编号,名称,效果\n"
	fixtures = append(fixtures,
		nativeParityFixture{Name: "mova trailing ignored", Before: header + "1,A,x,ignored\n,,extra-only", After: header + "1,A,x,other"},
		nativeParityFixture{Name: "mova unkeyed duplicates", Before: header + "1,A,x\n,重复,a\n,重复,a\n,停用,old", After: header + "1,A,x\n,重复,a\n,停用,new"},
		nativeParityFixture{Name: "mova duplicate anchor", Before: header + "1,A,x\n,重复,a\n,重复,a\n2,B,y", After: header + "1,A,x\n,重复,a\n2,B,y"},
		nativeParityFixture{Name: "mova unkeyed reordered fields", Before: header + "1,A,x\n,停用,a\n2,B,y", After: "ts,ts,none\nint32,string,string\nid,effect,name\n编号,效果,名称\n,changed,新停用\n0,z,新记录\n1,x,A\n2,y,B\n,a,停用"},
		nativeParityFixture{Name: "mova blank composite key", Before: header + ",A,x", Options: tableOptions{"keyColumns": []string{"id", "name"}}},
		nativeParityFixture{Name: "mova whitespace key", Before: header + " ,A,x"},
		nativeParityFixture{Name: "mova position unkeyed", Before: header + ",A,x", After: header + ",A,x", Options: tableOptions{"alignment": "position"}},
	)
	oldFixture, err := os.ReadFile(filepath.Join("..", "test", "fixtures", "before.csv"))
	if err != nil {
		t.Fatal(err)
	}
	newFixture, err := os.ReadFile(filepath.Join("..", "test", "fixtures", "after.csv"))
	if err != nil {
		t.Fatal(err)
	}
	fixtures = append(fixtures, nativeParityFixture{Name: "repository mova fixture", Before: string(oldFixture), After: string(newFixture)})
	for _, pair := range [][2][]string{{{"X", "Y", "A", "D", "E", "B", "T", "U"}, {"A", "B"}}, {{"A", "D", "B"}, {"A", "N", "B"}}, {{"A", "D"}, {"A", "N"}}, {{"A", "B", "D"}, {"B", "A"}}, {{"A", "B"}, {"N", "M"}}, {{"A", "B"}, {}}, {{}, {"N", "M"}}} {
		fixtures = append(fixtures, nativeParityFixture{Name: fmt.Sprint("deleted anchors ", pair), Before: nativeIDCSV(pair[0]), After: nativeIDCSV(pair[1])})
	}
	random := rand.New(rand.NewSource(149))
	for i := 0; i < 50; i++ {
		left, right := make([]string, 0), make([]string, 0)
		for _, n := range random.Perm(12) {
			if random.Intn(3) != 0 {
				left = append(left, fmt.Sprint(n))
			}
		}
		for _, n := range random.Perm(12) {
			if random.Intn(3) != 0 {
				right = append(right, fmt.Sprint(n))
			}
		}
		fixtures = append(fixtures, nativeParityFixture{Name: fmt.Sprintf("seeded ordering %d", i), Before: nativeIDCSV(left), After: nativeIDCSV(right)})
	}
	var large strings.Builder
	large.WriteString("id,name,value,rare\n")
	for i := 0; i < 205; i++ {
		fmt.Fprintf(&large, "%d,name%d,same,old\n", i, i)
	}
	fixtures = append(fixtures, nativeParityFixture{Name: "full result column union", Before: large.String(), After: strings.Replace(strings.Replace(large.String(), "0,name0,same", "0,name0,new", 1), "204,name204,same,old", "204,name204,same,new", 1)})
	wide := make([]string, 400)
	for i := range wide {
		wide[i] = fmt.Sprintf("f%d", i)
	}
	var wideCSV strings.Builder
	wideCSV.WriteString(strings.Join(wide, ",") + "\n")
	for i := 0; i < 20; i++ {
		fmt.Fprintf(&wideCSV, "%d,%sv\n", i, strings.Repeat("v,", 398))
	}
	fixtures = append(fixtures, nativeParityFixture{Name: "wide page clamp", After: wideCSV.String()})
	meta := func(kind string, raw any) cellMetadata { return cellMetadata{Type: kind, Raw: raw} }
	typedRows := [][]string{{"id", "v"}, {"1", "same"}, {"001", "same"}, {"true", "TRUE"}, {"<>&", "empty"}}
	typedMeta := [][]cellMetadata{{meta("string", "id"), meta("string", "v")}, {meta("number", 1.0), meta("number", 1.0)}, {meta("string", "1"), meta("string", "1")}, {meta("boolean", true), meta("boolean", true)}, {meta("string", "<>&"), meta("empty", nil)}}
	changedMeta := make([][]cellMetadata, len(typedMeta))
	for i, row := range typedMeta {
		changedMeta[i] = append([]cellMetadata(nil), row...)
	}
	changedMeta[1][1] = meta("string", "1")
	changedMeta[4][1] = meta("string", "")
	fixtures = append(fixtures,
		nativeParityFixture{Name: "typed raw identities and hidden changes", Rows: [][][]string{typedRows, typedRows}, Metadata: [][][]cellMetadata{typedMeta, changedMeta}},
		nativeParityFixture{Name: "negative zero duplicate key", Rows: [][][]string{{{"id"}, {"0"}, {"-0"}}, {}}, Metadata: [][][]cellMetadata{{{meta("string", "id")}, {meta("number", 0.0)}, {meta("number", math.Copysign(0, -1))}}, {}}},
		nativeParityFixture{Name: "raw null missing key", Rows: [][][]string{{{"id"}, {"shown"}}, {}}, Metadata: [][][]cellMetadata{{{meta("string", "id")}, {meta("empty", nil)}}, {}}},
	)
	for i := range fixtures {
		fixtures[i].States = states
	}
	input, err := json.Marshal(fixtures)
	if err != nil {
		t.Fatal(err)
	}
	const script = `const fs=require('node:fs'); const {parseCSV,readTableRows}=require('./src/csv'); const {compareTables}=require('./src/diff'); const {selectView}=require('./media/view'); const fixtures=JSON.parse(fs.readFileSync(0,'utf8')); process.stdout.write(JSON.stringify(fixtures.map(f=>{try { const tables=[f.before,f.after].map((text,i)=>readTableRows(f.rows?f.rows[i]:parseCSV(text),f.options||{},f.metadata?f.metadata[i]:undefined)); const model=compareTables(...tables,f.options||{}); return {model,views:f.states.map(state=>selectView(model,state))}; } catch(e) {return {error:e.message};}})));`
	command := exec.Command(node, "-e", script)
	command.Dir = ".."
	command.Stdin = bytes.NewReader(input)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("plugin reference: %v: %s", err, output)
	}
	var reference []json.RawMessage
	if err := json.Unmarshal(output, &reference); err != nil {
		t.Fatal(err)
	}
	for i, fixture := range fixtures {
		t.Run(fixture.Name, func(t *testing.T) {
			actual, err := json.Marshal(evaluateNativeFixture(fixture))
			if err != nil {
				t.Fatal(err)
			}
			var got, want any
			if err := json.Unmarshal(actual, &got); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(reference[i], &want); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("native/plugin differ\nnative: %s\nplugin: %s", actual, reference[i])
			}
		})
	}
}

func nativeIDCSV(ids []string) string {
	var out strings.Builder
	out.WriteString("id,value\n")
	for _, id := range ids {
		out.WriteString(id + ",same\n")
	}
	return out.String()
}

func TestNativeComparisonRejectsCombinedCellBudgetBeforeRows(t *testing.T) {
	// Deliberately omit values: a late budget check would index these invalid rows.
	table := &tableData{Fields: []tableField{{Name: "id"}, {Name: "v"}}, Rows: make([]tableRow, 250001)}
	if _, err := compareNativeTables(table, table, nil); err == nil || !strings.Contains(err.Error(), "100 万单元格") {
		t.Fatal("missing combined cell limit", err)
	}
}

func TestNativePreparedMetadataAndBlankRecords(t *testing.T) {
	rows, _ := parseCSVRows("id,value,empty\n1,a\n,,\n\n2,b")
	table, err := prepareTable(rows, [][]cellMetadata{{}, {{Type: "number", Raw: 1.0}, {Type: "string", Raw: "a"}, {}}, {}, {}, {{}}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if table.SkippedBlankRows != 2 || table.Rows[1].Record != 5 || table.Rows[0].Metadata[2].Type != "empty" || table.Rows[1].Metadata[0].Type != "empty" || table.Rows[1].Metadata[0].Raw != nil {
		t.Fatalf("padding/record semantics differ: %#v", table)
	}
}
