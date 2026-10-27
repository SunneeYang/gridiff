package main

type cellMetadata struct {
	Type string `json:"type"`
	Raw  any    `json:"raw"`
}

type rawSheet struct {
	Name     string           `json:"name"`
	Values   [][]string       `json:"values"`
	Metadata [][]cellMetadata `json:"metadata,omitempty"`
}

type tableOptions map[string]any

type tableField struct {
	Name  string `json:"name"`
	Label string `json:"label"`
	Type  string `json:"type"`
	Flags string `json:"flags"`
	Index int    `json:"index"`
}

type tableRow struct {
	Record   int            `json:"record"`
	Values   []string       `json:"values"`
	Metadata []cellMetadata `json:"metadata,omitempty"`
}

type tableData struct {
	Format           string       `json:"format"`
	Fields           []tableField `json:"fields"`
	Rows             []tableRow   `json:"rows"`
	SkippedBlankRows int          `json:"skippedBlankRows"`
}

type diffField struct {
	Name   string      `json:"name"`
	Before *tableField `json:"before"`
	After  *tableField `json:"after"`
}

type diffCell struct {
	Before     *string       `json:"before"`
	After      *string       `json:"after"`
	Changed    bool          `json:"changed"`
	BeforeMeta *cellMetadata `json:"beforeMeta,omitempty"`
	AfterMeta  *cellMetadata `json:"afterMeta,omitempty"`
}

type diffRow struct {
	Key           string     `json:"key,omitempty"`
	Unkeyed       bool       `json:"unkeyed"`
	Identity      string     `json:"identity"`
	BeforeRecord  *int       `json:"beforeRecord"`
	AfterRecord   *int       `json:"afterRecord"`
	Status        string     `json:"status"`
	Moved         bool       `json:"moved"`
	Cells         []diffCell `json:"cells"`
	DisplayName   string     `json:"displayName,omitempty"`
	SchemaChanged bool       `json:"schemaChanged,omitempty"`
}

type schemaChange struct {
	Name   string `json:"name"`
	Kind   string `json:"kind"`
	Before any    `json:"before"`
	After  any    `json:"after"`
}

type diffCounts struct {
	Added     int `json:"added"`
	Removed   int `json:"removed"`
	Modified  int `json:"modified"`
	Unchanged int `json:"unchanged"`
	Moved     int `json:"moved"`
	Cells     int `json:"cells"`
	Schema    int `json:"schema"`
}

type diffModel struct {
	Fields    []diffField    `json:"fields"`
	Rows      []diffRow      `json:"rows"`
	Schema    []schemaChange `json:"schema"`
	Counts    diffCounts     `json:"counts"`
	Keys      []string       `json:"keys"`
	Alignment string         `json:"alignment"`
	Formats   []string       `json:"formats"`
	Unkeyed   map[string]int `json:"unkeyed"`
}

type viewState struct {
	View        string `json:"view"`
	OnlyChanges bool   `json:"onlyChanges"`
	OnlyFields  bool   `json:"onlyFields"`
	Query       string `json:"query"`
	Page        int    `json:"page"`
}

type pageInfo struct {
	Page         int   `json:"page"`
	Pages        int   `json:"pages"`
	PageSize     int   `json:"pageSize"`
	FieldIndexes []int `json:"fieldIndexes"`
	TotalRows    int   `json:"totalRows"`
	FilteredRows int   `json:"filteredRows"`
}
