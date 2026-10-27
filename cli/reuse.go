package main

import (
	"bufio"
	"bytes"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"time"
)

type launchRequest struct {
	SheetSelection sheetSelection `json:"sheetSelection"`
	Files          []string       `json:"files"`
	InstancePath   string         `json:"instancePath,omitempty"`
	Open           bool           `json:"open"`
}
type submission struct {
	URL        string `json:"url"`
	Generation uint64 `json:"generation"`
	Open       bool   `json:"open"`
}
type discovery struct {
	Build   string `json:"build"`
	URL     string `json:"url"`
	Control string `json:"control"`
}

func (s *comparisonServer) submission(open bool) submission {
	s.mu.Lock()
	defer s.mu.Unlock()
	shouldOpen := open && len(s.viewers) == 0 && time.Now().After(s.openUntil)
	if shouldOpen {
		s.openUntil = time.Now().Add(15 * time.Second)
	}
	return submission{s.URL, s.generation, shouldOpen}
}

func readDiscovery(file string) (discovery, error) {
	var value discovery
	f, err := os.Open(file)
	if err != nil {
		return value, err
	}
	defer f.Close()
	bytes, err := io.ReadAll(io.LimitReader(f, 4097))
	if err != nil || len(bytes) > 4096 || json.Unmarshal(bytes, &value) != nil {
		return value, errors.New("本地服务记录无效")
	}
	u, err := url.Parse(value.URL)
	if err != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.RawPath != "" ||
		!regexp.MustCompile(`^/s/[a-f0-9]{48}/$`).MatchString(u.Path) || !regexp.MustCompile(`^[a-f0-9]{48}$`).MatchString(value.Control) || value.Build != buildID {
		return value, errors.New("本地服务记录无效")
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil || port < 1 || port > 65535 {
		return value, errors.New("本地服务端口无效")
	}
	return value, nil
}

func (s *comparisonServer) saveDiscovery() error {
	value, _ := json.Marshal(discovery{buildID, s.URL, s.control})
	f, err := os.CreateTemp(filepath.Dir(s.instancePath), ".instance-")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if _, err = f.Write(value); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return os.Rename(name, s.instancePath)
}
func (s *comparisonServer) removeDiscovery() {
	lock, err := lockInstance(s.instancePath + ".lock")
	if err != nil {
		return
	}
	defer lock.Close()
	if record, err := readDiscovery(s.instancePath); err == nil && record.Control == s.control {
		_ = os.Remove(s.instancePath)
	}
}

func reusable(files []string, open bool, selection sheetSelection) (submission, error) {
	directory := os.Getenv("GRIDIFF_RUNTIME_DIR")
	if directory == "" {
		root, err := os.UserCacheDir()
		if err != nil {
			return submission{}, err
		}
		directory = filepath.Join(root, "gridiff", "instances")
	}
	if err := os.MkdirAll(directory, 0700); err != nil {
		return submission{}, err
	}
	if err := os.Chmod(directory, 0700); err != nil {
		return submission{}, err
	}
	// The build fingerprint isolates incompatible local builds even when their version is unchanged.
	file := filepath.Join(directory, buildID+".json")
	lock, err := lockInstance(file + ".lock")
	if err != nil {
		return submission{}, err
	}
	defer lock.Close()
	if record, err := readDiscovery(file); err == nil {
		reply, reachable, err := submitExisting(record, files, open, selection)
		if reachable {
			return reply, err
		}
	}
	return background(files, file, open, selection)
}

func submitExisting(record discovery, files []string, open bool, selection sheetSelection) (submission, bool, error) {
	var reply submission
	body, _ := json.Marshal(map[string]any{"files": files, "open": open, "sheetSelection": selection})
	request, err := http.NewRequest(http.MethodPost, record.URL+"submit", bytes.NewReader(body))
	if err != nil {
		return reply, true, err
	}
	request.Header.Set("Authorization", "Bearer "+record.Control)
	request.Header.Set("Content-Type", "application/json")
	// The discovery URL is loopback-only; a direct HTTP connection avoids TLS/proxy machinery.
	address, err := url.Parse(record.URL)
	if err != nil {
		return reply, true, err
	}
	connection, err := net.DialTimeout("tcp4", address.Host, time.Second)
	if err != nil {
		return reply, false, nil
	}
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(time.Minute))
	if err := request.Write(connection); err != nil {
		return reply, true, err
	}
	response, err := http.ReadResponse(bufio.NewReader(connection), request)
	if err != nil {
		return reply, true, err
	}
	defer response.Body.Close()
	if response.Header.Get("X-Gridiff-Build") != buildID || response.StatusCode == http.StatusGone || response.StatusCode == http.StatusNotFound {
		return reply, false, nil
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 8193))
	if err != nil {
		return reply, true, err
	}
	if len(data) > 8192 {
		return reply, true, errors.New("本地服务响应过大")
	}
	if response.StatusCode != http.StatusOK {
		var failure struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(data, &failure)
		return reply, true, fmt.Errorf("提交比较失败：%s (%d)", failure.Error, response.StatusCode)
	}
	if json.Unmarshal(data, &reply) != nil || reply.URL != record.URL || reply.Generation == 0 {
		return reply, true, errors.New("本地服务响应无效")
	}
	return reply, true, nil
}

func (s *comparisonServer) submit(w http.ResponseWriter, r *http.Request) {
	if s.control == "" || r.Header.Get("Origin") != "" || r.Header.Get("Sec-Fetch-Site") != "" || r.Header.Get("Sec-Fetch-Mode") != "" ||
		subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+s.control)) != 1 {
		failHTTP(w, 403, "仅允许本机 Gridiff 命令提交比较")
		return
	}
	object, err := readObject(w, r, 65536)
	if err != nil {
		failHTTP(w, 400, err.Error())
		return
	}
	var files []string
	var open bool
	if (len(object) != 2 && len(object) != 3) || json.Unmarshal(object["files"], &files) != nil || len(files) != 2 || json.Unmarshal(object["open"], &open) != nil {
		failHTTP(w, 400, "比较请求无效")
		return
	}
	selection := sheetSelection{}
	for key := range object {
		if key != "files" && key != "open" && key != "sheetSelection" {
			failHTTP(w, 400, "比较请求无效")
			return
		}
	}
	if raw, ok := object["sheetSelection"]; ok {
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.DisallowUnknownFields()
		if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) || decoder.Decode(&selection) != nil {
			failHTTP(w, 400, "工作表范围无效")
			return
		}
	}
	for _, file := range files {
		if file != os.DevNull && !filepath.IsAbs(file) {
			failHTTP(w, 400, "需要绝对文件路径")
			return
		}
	}
	s.submitMu.Lock()
	defer s.submitMu.Unlock()
	data, err := makeSnapshot(files, selection)
	if err != nil {
		failHTTP(w, 400, err.Error())
		return
	}
	s.mu.Lock()
	if s.closing {
		s.mu.Unlock()
		failHTTP(w, 410, "比较会话已结束")
		return
	}
	s.generation++
	data.Generation = s.generation
	s.data = data
	s.timer.Reset(s.idle)
	for channel := range s.viewers {
		select {
		case <-channel:
		default:
		}
		select {
		case channel <- s.generation:
		default:
		}
	}
	s.mu.Unlock()
	writeJSON(w, 200, s.submission(open))
}

func (s *comparisonServer) events(w http.ResponseWriter, r *http.Request) {
	channel := make(chan uint64, 1)
	s.mu.Lock()
	if s.closing {
		s.mu.Unlock()
		failHTTP(w, 410, "比较会话已结束")
		return
	}
	s.viewers[channel] = true
	s.openUntil = time.Time{}
	generation := s.generation
	s.timer.Reset(s.idle)
	s.mu.Unlock()
	defer func() { s.mu.Lock(); delete(s.viewers, channel); s.mu.Unlock() }()
	// This route streams for the lifetime of the page; other responses retain the server deadline.
	_ = http.NewResponseController(w).SetWriteDeadline(time.Time{})
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("X-Accel-Buffering", "no")
	send := func(value string) bool {
		_, err := io.WriteString(w, value)
		if err != nil {
			return false
		}
		return http.NewResponseController(w).Flush() == nil
	}
	if !send(fmt.Sprintf("data: %d\n\n", generation)) {
		return
	}
	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case generation = <-channel:
			if !send(fmt.Sprintf("data: %d\n\n", generation)) {
				return
			}
		case <-ticker.C:
			if !send(": heartbeat\n\n") {
				return
			}
			s.touch()
		case <-r.Context().Done():
			return
		case <-s.done:
			return
		}
	}
}
