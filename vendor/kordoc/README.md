# kordoc 브라우저 번들

`read_document`가 한글 문서(HWP 3·5, HWPX)를 읽을 때 쓰는 [kordoc](https://github.com/chrisryugj/kordoc)(MIT)을
브라우저 module Worker용으로 묶은 결과물이다. 확장 빌드는 `dist/kordoc-hwp.js`만 쓴다(`vite.config.ts`의 `kordoc-hwp` 별칭).

kordoc는 Node용이고 설치하면 OCR·PDF 렌더러 등 선택 의존성까지 600MB가 넘게 깔린다. 그래서 확장의
`package.json`에 넣지 않고 이 폴더에서 따로 설치해 묶은 뒤 결과물을 커밋한다.

## 다시 만들기

```sh
cd vendor/kordoc
npm ci --ignore-scripts
npm run build
cd ../.. && npm test   # tests/hwp.test.mjs가 번들을 검사한다
```

버전은 `package.json`/`package-lock.json`에 고정한다. 아래 보완은 kordoc 내부 코드에 기대므로,
버전을 올리면 `npm test`와 실제 확장에서 HWP·HWPX 읽기를 꼭 확인한다.

## 브라우저용 보완 (`build.mjs`)

- `entry.mjs`: HWP 3·5·HWPX 파서와 형식 판별 함수만 내보낸다.
- Node 내장 모듈(`fs`, `path`, `crypto` 등) → `shims/stub.mjs`(호출하면 오류). `createRequire("cfb")`만 실제 cfb를 돌려준다.
- `zlib` → `shims/zlib.mjs`(pako). kordoc가 Node `Buffer` 메서드를 쓰므로 결과를 `Buffer`로 감싼다.
- `Buffer`·`process` 전역 → `shims/globals.mjs`(buffer 패키지).
- `pdfjs-dist` → `shims/pdfjs.mjs`(빈 모듈). PDF는 확장이 pdf.js로 따로 읽는다.
- OCR·이미지·MCP·CLI용 선택 의존성 → 빈 모듈.
- jszip의 `nodeStream()`은 브라우저에서 지원되지 않아, kordoc 코드의 호출을 같은 이벤트를 내는 `internalStream()`으로 바꾼다.

## 라이선스

kordoc: MIT (`dist/LICENSE.kordoc`, `dist/NOTICE.kordoc`). 번들에 함께 들어간 라이브러리의 저작권 표시는
`dist/kordoc-hwp.js` 끝에 있다(cfb Apache-2.0, jszip MIT/GPLv3 중 MIT, @xmldom/xmldom MIT, pako MIT/Zlib,
buffer MIT, markdown-it MIT, zod MIT).
