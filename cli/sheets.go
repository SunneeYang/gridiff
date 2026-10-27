package main

import "errors"

type sheetSelection struct {
	Mode  string   `json:"mode"`
	Names []string `json:"names,omitempty"`
}

func (s sheetSelection) normalized() (sheetSelection, error) {
	if s.Mode == "" {
		s.Mode = "first"
	}
	if s.Mode != "first" && s.Mode != "all" && s.Mode != "named" {
		return s, errors.New("XLSX 工作表范围必须为 first、all 或 named")
	}
	if (s.Mode == "named") != (len(s.Names) > 0) {
		return s, errors.New("仅 named 范围需要指定至少一个工作表名称")
	}
	seen := make(map[string]bool)
	names := make([]string, 0, len(s.Names))
	for _, name := range s.Names {
		if name == "" {
			return s, errors.New("XLSX 工作表名称不能为空")
		}
		if !seen[name] {
			names = append(names, name)
			seen[name] = true
		}
	}
	s.Names = names
	return s, nil
}
