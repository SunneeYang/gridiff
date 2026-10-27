package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/rand"
	"embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"
)

//go:embed assets/*
var assetsFS embed.FS

var version = "dev"
var buildID = "dev"

const maxBytes = 8 * 1024 * 1024
const csp = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

type snapshot struct {
	SheetSelection sheetSelection `json:"sheetSelection"`
	Generation     uint64         `json:"generation"`
	Sources        []string       `json:"sources"`
	Title          string         `json:"title"`
	XLSX           bool           `json:"xlsx"`
	Inputs         []string       `json:"inputs"`
	Error          string         `json:"error,omitempty"`
	Unsupported    bool           `json:"unsupported,omitempty"`
	Metrics        []phaseMetric  `json:"metrics,omitempty"`
}

type phaseMetric struct {
	Phase string  `json:"phase"`
	MS    float64 `json:"ms"`
	Bytes int     `json:"bytes"`
}

type preferences struct {
	Mode    string `json:"mode"`
	Palette string `json:"palette"`
}

var defaultPreferences = preferences{Mode: "system", Palette: "default"}

type serverOptions struct {
	SheetSelection sheetSelection
	Files          []string
	ConfigPath     string
	Startup        time.Duration
	Idle           time.Duration
	InstancePath   string
}

type comparisonServer struct {
	URL          string
	origin       string
	prefix       string
	configPath   string
	idle         time.Duration
	http         *http.Server
	mu           sync.Mutex
	data         *snapshot
	timer        *time.Timer
	closing      bool
	done         chan struct{}
	once         sync.Once
	submitMu     sync.Mutex
	generation   uint64
	viewers      map[chan uint64]bool
	control      string
	instancePath string
	openUntil    time.Time
}

func readSnapshot(file string) ([]byte, error) {
	if file == os.DevNull {
		return nil, nil
	}
	info, err := os.Stat(file)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("请选择普通文件：%s", file)
	}
	if info.Size() > maxBytes {
		return nil, errors.New("单侧文件超过 8 MiB，请缩小表格")
	}
	f, err := os.Open(file)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxBytes {
		return nil, errors.New("单侧文件超过 8 MiB，请缩小表格")
	}
	return data, nil
}

func makeSnapshot(files []string, selection sheetSelection) (*snapshot, error) {
	started := time.Now()
	selection, err := selection.normalized()
	if err != nil {
		return nil, err
	}
	if len(files) != 2 || files[0] == "" || files[1] == "" {
		return nil, errors.New("需要旧版本和新版本两个文件")
	}
	result := &snapshot{SheetSelection: selection, Sources: make([]string, 2), Inputs: make([]string, 2)}
	record := func(phase string, start time.Time, size int) {
		result.Metrics = append(result.Metrics, phaseMetric{phase, float64(time.Since(start).Microseconds()) / 1000, size})
	}
	kinds := make([]string, 2)
	for i, file := range files {
		if file == os.DevNull || (runtime.GOOS == "windows" && strings.EqualFold(file, os.DevNull)) {
			result.Sources[i] = os.DevNull
			continue
		}
		absolute, err := filepath.Abs(file)
		if err != nil {
			return nil, err
		}
		result.Sources[i] = absolute
		ext := strings.ToLower(filepath.Ext(absolute))
		if ext != ".csv" && ext != ".xlsx" {
			result.Unsupported = true
		}
		kinds[i] = ext
	}
	result.Title = filepath.Base(result.Sources[1])
	if result.Unsupported {
		result.Error = "不支持此文件类型。支持的格式：CSV（.csv）、Excel 工作簿（.xlsx）。请使用 Fork 内置对比查看其他文件。"
	} else if kinds[0] != "" && kinds[1] != "" && kinds[0] != kinds[1] {
		result.Unsupported = true
		result.Error = "暂不支持混合比较。请选择两份 CSV（.csv）或两份 Excel 工作簿（.xlsx）。"
	}
	if result.Unsupported {
		record("server.snapshot", started, 0)
		return result, nil
	}
	result.XLSX = kinds[0] == ".xlsx" || kinds[1] == ".xlsx"
	buffers := make([][]byte, 2)
	for i, file := range result.Sources {
		start := time.Now()
		var err error
		buffers[i], err = readSnapshot(file)
		record("server.read", start, len(buffers[i]))
		if err != nil {
			return nil, err
		}
	}
	if result.XLSX {
		var pending sync.WaitGroup
		var failures [2]error
		var metrics [2][]phaseMetric
		for i, data := range buffers {
			pending.Add(1)
			go func(i int, data []byte) {
				defer pending.Done()
				record := func(phase string, start time.Time, size int) {
					metrics[i] = append(metrics[i], phaseMetric{phase, float64(time.Since(start).Microseconds()) / 1000, size})
				}
				if len(data) > 0 {
					start := time.Now()
					prepared, err := prepareArchive(data, true, selection)
					record("server.xlsx_validate", start, len(data))
					if err != nil {
						failures[i] = err
						return
					}
					data = prepared
				}
				start := time.Now()
				result.Inputs[i] = base64.StdEncoding.EncodeToString(data)
				record("server.base64", start, len(data))
			}(i, data)
		}
		pending.Wait()
		for i, err := range failures {
			result.Metrics = append(result.Metrics, metrics[i]...)
			if err != nil && result.Error == "" {
				result.Error = "无法读取 XLSX：" + err.Error()
				result.Inputs = []string{"", ""}
			}
		}
	} else {
		for i, data := range buffers {
			if !utf8.Valid(data) || bytes.IndexByte(data, 0) >= 0 {
				return nil, errors.New("CSV 必须是 UTF-8 文本，请检查文件编码或格式")
			}
			result.Inputs[i] = string(data)
		}
	}
	record("server.snapshot", started, len(buffers[0])+len(buffers[1]))
	return result, nil
}

func startServer(options serverOptions) (*comparisonServer, error) {
	data, err := makeSnapshot(options.Files, options.SheetSelection)
	if err != nil {
		return nil, err
	}
	if options.ConfigPath == "" {
		directory, err := os.UserConfigDir()
		if err != nil {
			return nil, err
		}
		options.ConfigPath = filepath.Join(directory, "gridiff", "preferences.json")
	}
	if options.Startup <= 0 {
		options.Startup = 2 * time.Minute
	}
	if options.Idle <= 0 {
		options.Idle = 10 * time.Minute
	}
	token := make([]byte, 24)
	if _, err := rand.Read(token); err != nil {
		return nil, err
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	s := &comparisonServer{origin: "http://" + listener.Addr().String(), prefix: "/s/" + hex.EncodeToString(token) + "/", configPath: options.ConfigPath, data: data, idle: options.Idle, done: make(chan struct{})}
	s.generation = 1
	data.Generation = 1
	s.viewers = make(map[chan uint64]bool)
	s.instancePath = options.InstancePath
	if s.instancePath != "" {
		if _, err := rand.Read(token); err != nil {
			listener.Close()
			return nil, err
		}
		s.control = hex.EncodeToString(token)
	}
	s.URL = s.origin + s.prefix
	s.http = &http.Server{Handler: s, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 * 1024}
	s.mu.Lock()
	s.timer = time.AfterFunc(options.Startup, s.Close)
	s.mu.Unlock()
	go func() { _ = s.http.Serve(listener); s.Close() }()
	return s, nil
}

func (s *comparisonServer) touch() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.closing {
		s.timer.Reset(s.idle)
	}
}

func (s *comparisonServer) Close() {
	s.once.Do(func() {
		s.mu.Lock()
		s.closing = true
		s.data = nil
		s.timer.Stop()
		s.mu.Unlock()
		_ = s.http.Close()
		if s.instancePath != "" {
			s.removeDiscovery()
		}
		close(s.done)
	})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func failHTTP(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func readObject(w http.ResponseWriter, r *http.Request) (map[string]json.RawMessage, error) {
	media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/json" {
		return nil, errors.New("请求必须使用 JSON")
	}
	r.Body = http.MaxBytesReader(w, r.Body, 65536)
	defer r.Body.Close()
	decoder := json.NewDecoder(r.Body)
	var value map[string]json.RawMessage
	if err := decoder.Decode(&value); err != nil {
		return nil, errors.New("请求内容无效或过大")
	}
	if value == nil {
		return nil, errors.New("请求内容无效")
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return nil, errors.New("请求内容无效")
	}
	return value, nil
}

func validPreferences(p preferences) bool {
	return (p.Mode == "system" || p.Mode == "light" || p.Mode == "dark") &&
		(p.Palette == "default" || p.Palette == "github" || p.Palette == "catppuccin" || p.Palette == "solarized" || p.Palette == "nord")
}

func loadPreferences(file string) preferences {
	f, err := os.Open(file)
	if err != nil {
		return defaultPreferences
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, 4097))
	var p preferences
	if err != nil || len(data) > 4096 || json.Unmarshal(data, &p) != nil || !validPreferences(p) {
		return defaultPreferences
	}
	return p
}

func savePreferences(file string, p preferences) error {
	if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(file), ".preferences-")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if err := json.NewEncoder(f).Encode(p); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(name, file)
}

func (s *comparisonServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Security-Policy", csp)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Gridiff-Build", buildID)
	if r.Host != strings.TrimPrefix(s.origin, "http://") || (r.Header.Get("Origin") != "" && r.Header.Get("Origin") != s.origin) ||
		(r.Header.Get("Sec-Fetch-Site") != "" && r.Header.Get("Sec-Fetch-Site") != "none" && r.Header.Get("Sec-Fetch-Site") != "same-origin") {
		failHTTP(w, 403, "仅允许本地比较页面访问")
		return
	}
	s.mu.Lock()
	closing, data := s.closing, s.data
	s.mu.Unlock()
	if closing {
		failHTTP(w, 410, "比较会话已结束")
		return
	}
	if !strings.HasPrefix(r.URL.Path, s.prefix) || r.URL.RawQuery != "" || r.URL.EscapedPath() != r.URL.Path {
		failHTTP(w, 404, "比较会话不存在")
		return
	}
	route := strings.TrimPrefix(r.URL.Path, s.prefix)
	if r.Method == http.MethodGet {
		switch route {
		case "snapshot":
			s.touch()
			writeJSON(w, 200, data)
		case "preferences":
			writeJSON(w, 200, loadPreferences(s.configPath))
		case "events":
			s.events(w, r)
		default:
			if route == "" {
				route = "index.html"
				s.touch()
			}
			serveAsset(w, r, route)
		}
		return
	}
	if r.Method != http.MethodPost || (route != "heartbeat" && route != "close" && route != "preferences" && route != "submit") {
		failHTTP(w, 405, "请求方式无效")
		return
	}
	if route == "submit" {
		s.submit(w, r)
		return
	}
	object, err := readObject(w, r)
	if err != nil {
		failHTTP(w, 400, err.Error())
		return
	}
	if route == "preferences" {
		var p preferences
		if len(object) != 2 || json.Unmarshal(object["mode"], &p.Mode) != nil || json.Unmarshal(object["palette"], &p.Palette) != nil || !validPreferences(p) {
			failHTTP(w, 400, "主题设置无效")
			return
		}
		if err := savePreferences(s.configPath, p); err != nil {
			failHTTP(w, 500, "无法保存主题设置："+err.Error())
			return
		}
		s.touch()
		writeJSON(w, 200, p)
		return
	}
	if len(object) != 0 {
		failHTTP(w, 400, "请求内容无效")
		return
	}
	if route == "heartbeat" {
		s.touch()
		w.WriteHeader(204)
		return
	}
	w.WriteHeader(204)
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
	go s.Close()
}

func asset(name string) ([]byte, error) {
	switch name {
	case "index.html", "main.js", "main.css", "browser.js", "worker.js", "view.js", "themes.js", "themes.css", "licenses.txt":
		return assetsFS.ReadFile("assets/" + name + ".gz")
	default:
		return nil, os.ErrNotExist
	}
}

func serveAsset(w http.ResponseWriter, r *http.Request, name string) {
	data, err := asset(name)
	if err != nil {
		failHTTP(w, 404, "页面不存在")
		return
	}
	contentType := "text/plain; charset=utf-8"
	switch filepath.Ext(name) {
	case ".html":
		contentType = "text/html; charset=utf-8"
	case ".js":
		contentType = "text/javascript; charset=utf-8"
	case ".css":
		contentType = "text/css; charset=utf-8"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Vary", "Accept-Encoding")
	for _, encoding := range strings.Split(r.Header.Get("Accept-Encoding"), ",") {
		parts := strings.Split(strings.TrimSpace(encoding), ";")
		if parts[0] == "gzip" && (len(parts) == 1 || strings.TrimSpace(parts[1]) != "q=0") {
			w.Header().Set("Content-Encoding", "gzip")
			_, _ = w.Write(data)
			return
		}
	}
	reader, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		failHTTP(w, 500, "页面资源损坏")
		return
	}
	defer reader.Close()
	_, _ = io.Copy(w, reader)
}

func waitServer(s *comparisonServer) {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	select {
	case <-s.done:
	case <-ctx.Done():
		s.Close()
	}
}

func background(files []string, instancePath string, open bool, selection sheetSelection) (submission, error) {
	executable, err := os.Executable()
	if err != nil {
		return submission{}, err
	}
	command := exec.Command(executable, "--serve")
	detach(command)
	input, _ := json.Marshal(launchRequest{Files: files, InstancePath: instancePath, Open: open, SheetSelection: selection})
	command.Stdin = bytes.NewReader(input)
	output, err := command.StdoutPipe()
	if err != nil {
		return submission{}, err
	}
	if err := command.Start(); err != nil {
		return submission{}, err
	}
	type answer struct {
		submission
		Error string `json:"error"`
	}
	ch := make(chan struct {
		value answer
		err   error
	}, 1)
	go func() {
		var value answer
		err := json.NewDecoder(io.LimitReader(bufio.NewReader(output), 8192)).Decode(&value)
		ch <- struct {
			value answer
			err   error
		}{value, err}
	}()
	var response answer
	select {
	case result := <-ch:
		response, err = result.value, result.err
	case <-time.After(time.Minute):
		err = errors.New("启动本地比较服务超时")
	}
	_ = output.Close()
	if err == nil && response.Error != "" {
		err = errors.New(response.Error)
	}
	if err == nil {
		u, parseErr := url.Parse(response.URL)
		if parseErr != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.Port() == "" || !strings.HasPrefix(u.Path, "/s/") {
			err = errors.New("比较服务响应无效")
		}
	}
	if err != nil {
		_ = command.Process.Kill()
		_ = command.Wait()
		return submission{}, err
	}
	_ = command.Process.Release()
	return response.submission, nil
}

func openBrowser(address string) error {
	var command *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		command = exec.Command("/usr/bin/open", address)
	case "windows":
		command = exec.Command("rundll32.exe", "url.dll,FileProtocolHandler", address)
	default:
		command = exec.Command("xdg-open", address)
	}
	if err := command.Start(); err != nil {
		return err
	}
	finished := make(chan error, 1)
	go func() { finished <- command.Wait() }()
	select {
	case err := <-finished:
		return err
	case <-time.After(2 * time.Second):
		return nil
	}
}

func run(args []string) error {
	if len(args) == 1 && args[0] == "--serve" {
		var request launchRequest
		var s *comparisonServer
		err := json.NewDecoder(io.LimitReader(os.Stdin, 65537)).Decode(&request)
		if err == nil {
			s, err = startServer(serverOptions{Files: request.Files, InstancePath: request.InstancePath, SheetSelection: request.SheetSelection})
			if err == nil && request.InstancePath != "" {
				err = s.saveDiscovery()
				if err != nil {
					s.instancePath = ""
				}
			}
		}
		if err != nil {
			if s != nil {
				s.Close()
			}
			_ = json.NewEncoder(os.Stdout).Encode(map[string]string{"error": err.Error()})
			return err
		}
		_ = json.NewEncoder(os.Stdout).Encode(s.submission(request.Open))
		waitServer(s)
		return nil
	}
	if len(args) == 0 || (len(args) == 1 && (args[0] == "--help" || args[0] == "-h")) || (len(args) == 2 && args[0] == "diff" && (args[1] == "--help" || args[1] == "-h")) {
		fmt.Printf("Gridiff %s — 本地浏览器表格对比\n\n用法：gridiff [--no-open] [--wait] <旧文件> <新文件>\n\nFork 自定义外部 Diff：选择 gridiff，Arguments 保持默认 $LOCAL $REMOTE。\n兼容旧用法：gridiff diff <旧文件> <新文件>。\n支持 CSV 和 XLSX，只读比较，自动打开默认浏览器。\n数据保存在内存，不生成 HTML 或数据临时文件。\n\n  --no-open   仅打印地址，不打开浏览器\n  --wait      独立打开，等待结束比较或超时后退出\n  --sheets first|all  XLSX 读取首表（默认）或全部工作表\n  --sheet 名称        指定工作表，可重复；不能与 --sheets 同用\n  --version   显示版本\n  --licenses  显示许可声明\n  --help      显示帮助\n\n默认复用服务和页签，新比较替换当前内容；完成文件快照后返回。\n未打开页面时 2 分钟退出，失去心跳后 10 分钟退出。\n", version)
		return nil
	}
	if len(args) == 1 && args[0] == "--version" {
		fmt.Println(version)
		return nil
	}
	if len(args) == 1 && args[0] == "--licenses" {
		data, err := asset("licenses.txt")
		if err != nil {
			return err
		}
		reader, err := gzip.NewReader(bytes.NewReader(data))
		if err != nil {
			return err
		}
		defer reader.Close()
		_, err = io.Copy(os.Stdout, reader)
		return err
	}
	if args[0] == "diff" {
		args = args[1:]
	}
	var files []string
	noOpen, wait, literal := false, false, false
	selection := sheetSelection{}
	modeSet := false
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if !literal {
			switch arg {
			case "--sheets", "--sheet":
				if i+1 == len(args) {
					return fmt.Errorf("选项 %s 缺少值", arg)
				}
				i++
				value := args[i]
				if arg == "--sheets" {
					if modeSet || selection.Mode == "named" {
						return errors.New("--sheets 不能重复或与 --sheet 同用")
					}
					if value != "first" && value != "all" {
						return errors.New("--sheets 必须为 first 或 all")
					}
					selection.Mode = value
					modeSet = true
				} else {
					if modeSet {
						return errors.New("--sheet 不能与 --sheets 同用")
					}
					selection.Mode = "named"
					selection.Names = append(selection.Names, value)
				}
				continue
			case "--":
				literal = true
				continue
			case "--no-open":
				noOpen = true
				continue
			case "--wait":
				wait = true
				continue
			}
		}
		if !literal && strings.HasPrefix(arg, "-") {
			return fmt.Errorf("未知选项：%s", arg)
		}
		if arg == os.DevNull || (runtime.GOOS == "windows" && strings.EqualFold(arg, os.DevNull)) {
			files = append(files, os.DevNull)
			continue
		}
		absolute, err := filepath.Abs(arg)
		if err != nil {
			return err
		}
		files = append(files, absolute)
	}
	if len(files) != 2 {
		return errors.New("请选择旧版本和新版本两个文件")
	}
	selection, selectionErr := selection.normalized()
	if selectionErr != nil {
		return selectionErr
	}
	var address string
	var s *comparisonServer
	var err error
	shouldOpen := !noOpen
	if wait {
		s, err = startServer(serverOptions{Files: files, SheetSelection: selection})
		if err == nil {
			address = s.URL
		}
	} else {
		var reply submission
		reply, err = reusable(files, !noOpen, selection)
		address = reply.URL
		shouldOpen = reply.Open
	}
	if err != nil {
		return err
	}
	fmt.Println(address)
	if shouldOpen {
		if err := openBrowser(address); err != nil {
			fmt.Fprintln(os.Stderr, "未能自动打开浏览器，请手动打开上面的本地地址。")
		}
	}
	if s != nil {
		waitServer(s)
	}
	return nil
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "Gridiff:", err)
		os.Exit(1)
	}
}
