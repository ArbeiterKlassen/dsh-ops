//! A bounded PDF container: classic xref tables, xref streams, object streams and incremental updates.
use crate::pdf_syntax::{Dict, Lexer, Value, bad, limit, unsupported, white};
use ops_protocol::Result;
use std::collections::{BTreeMap, BTreeSet};

pub const MAX_FILE: usize = 16 * 1024 * 1024;
pub const MAX_OBJECTS: usize = 10_000;
pub const MAX_STREAM: usize = 1024 * 1024;
pub const MAX_XREF_SECTIONS: usize = 64;

pub type ObjectId = (u32, u16);

#[derive(Debug)]
pub struct Object<'a> {
    pub value: Value,
    pub stream: Option<&'a [u8]>,
}

#[derive(Debug)]
pub struct Document<'a> {
    pub objects: BTreeMap<ObjectId, Object<'a>>,
    pub root: ObjectId,
}

impl<'a> Document<'a> {
    pub fn object(&self, id: ObjectId) -> Result<&Object<'a>> {
        self.objects
            .get(&id)
            .ok_or_else(|| bad("PDF reference does not name an active object"))
    }

    pub fn resolve<'b>(&'b self, value: &'b Value) -> Result<&'b Value> {
        let mut current = value;
        let mut seen = BTreeSet::new();
        while let Value::Ref(number, generation) = current {
            if seen.len() >= 64 {
                return Err(limit("PDF reference chain exceeds 64"));
            }
            if !seen.insert((*number, *generation)) {
                return Err(bad("Cyclic PDF reference"));
            }
            let object = self.object((*number, *generation))?;
            if object.stream.is_some() {
                return Err(bad("A PDF stream cannot be used as a plain value"));
            }
            current = &object.value;
        }
        Ok(current)
    }
}

#[derive(Clone, Debug)]
enum XrefEntry {
    Free { generation: u16 },
    Offset { offset: usize, generation: u16 },
    Compressed { stream: u32, index: u32 },
}

#[derive(Debug)]
struct XrefSection {
    entries: BTreeMap<u32, XrefEntry>,
    trailer: Dict,
    end: usize,
}

pub fn get<'a>(dict: &'a Dict, key: &[u8]) -> Result<&'a Value> {
    dict.get(key)
        .ok_or_else(|| bad(format!("Missing PDF {}", String::from_utf8_lossy(key))))
}

fn trim_end(mut data: &[u8]) -> &[u8] {
    while data.last().is_some_and(|b| white(*b)) {
        data = &data[..data.len() - 1];
    }
    data
}

fn footer(data: &[u8]) -> Result<(usize, usize)> {
    let end = trim_end(data);
    let Some(before_eof) = end.strip_suffix(b"%%EOF") else {
        return Err(bad("PDF must end with %%EOF"));
    };
    if !before_eof.last().is_some_and(|b| white(*b)) {
        return Err(bad("Missing PDF EOF separator"));
    }
    let before_eof = trim_end(before_eof);
    let number_start = before_eof
        .iter()
        .rposition(|b| !b.is_ascii_digit())
        .map_or(0, |n| n + 1);
    if number_start == 0 || !white(before_eof[number_start - 1]) {
        return Err(bad("Missing PDF xref number separator"));
    }
    let mut number = Lexer::new(&before_eof[number_start..]);
    let xref = number.unsigned()?;
    let prefix = trim_end(&before_eof[..number_start]);
    let Some(before_start) = prefix.strip_suffix(b"startxref") else {
        return Err(bad("Missing final PDF startxref"));
    };
    if !before_start.last().is_some_and(|b| white(*b)) {
        return Err(bad("Missing PDF startxref separator"));
    }
    let footer_start = before_start.len();
    if xref >= footer_start {
        return Err(bad("PDF xref offset points outside object section"));
    }
    Ok((xref, footer_start))
}

fn integer(value: &Value, name: &str) -> Result<usize> {
    value
        .integer()
        .map_err(|_| bad(format!("PDF {name} must be a bounded nonnegative integer")))
}

fn object_id_number(value: &Value) -> Result<ObjectId> {
    match value {
        Value::Ref(number, generation) => Ok((*number, *generation)),
        _ => Err(bad("PDF Root must be an indirect reference")),
    }
}

fn object_any(
    data: &[u8],
    offset: usize,
    nodes: usize,
) -> Result<(ObjectId, Object<'_>, usize, usize)> {
    if !data.get(offset).is_some_and(u8::is_ascii_digit) {
        return Err(bad("PDF xref must point exactly to an object header"));
    }
    let mut lexer = Lexer {
        data,
        at: offset,
        nodes,
    };
    let number = lexer.unsigned()?;
    let generation = lexer.unsigned()?;
    if number >= MAX_OBJECTS || generation > u16::MAX as usize {
        return Err(bad("PDF object identity is outside its bounds"));
    }
    lexer.keyword(b"obj")?;
    let value = lexer.value(0)?;
    let mut stream = None;
    let token = lexer.word()?;
    if token == b"stream" {
        let length = get(value.dict()?, b"Length")?.integer()?;
        if length > MAX_STREAM {
            return Err(limit("PDF encoded stream exceeds 1 MiB"));
        }
        if lexer.data.get(lexer.at..lexer.at + 2) == Some(b"\r\n") {
            lexer.at += 2;
        } else if lexer.data.get(lexer.at) == Some(&b'\n') {
            lexer.at += 1;
        } else {
            return Err(bad("PDF stream keyword must be followed by LF or CRLF"));
        }
        let end = lexer
            .at
            .checked_add(length)
            .filter(|n| *n <= data.len())
            .ok_or_else(|| bad("PDF stream length exceeds its object"))?;
        stream = Some(&data[lexer.at..end]);
        lexer.at = end;
        lexer.keyword(b"endstream")?;
        lexer.keyword(b"endobj")?;
    } else if token != b"endobj" {
        return Err(bad("Unexpected token after PDF object"));
    }
    let id = (number as u32, generation as u16);
    Ok((id, Object { value, stream }, lexer.at, lexer.nodes))
}

fn classic_section(data: &[u8], offset: usize) -> Result<XrefSection> {
    let mut lexer = Lexer {
        data,
        at: offset,
        nodes: 0,
    };
    lexer.keyword(b"xref")?;
    let mut entries = BTreeMap::new();
    loop {
        lexer.skip();
        if data[lexer.at..].starts_with(b"trailer") {
            lexer.keyword(b"trailer")?;
            break;
        }
        let start = lexer.unsigned()?;
        let count = lexer.unsigned()?;
        if count == 0 {
            return Err(bad("PDF xref subsection cannot be empty"));
        }
        if start >= MAX_OBJECTS || count > MAX_OBJECTS - start {
            return Err(limit("PDF xref exceeds 10000 entries"));
        }
        for number in start..start + count {
            let field = lexer.unsigned()?;
            let generation = lexer.unsigned()?;
            let flag = lexer.word()?;
            if generation > u16::MAX as usize
                || (flag == b"n" && generation == u16::MAX as usize)
                || !matches!(flag, b"n" | b"f")
            {
                return Err(bad("Invalid PDF xref entry"));
            }
            let entry = if flag == b"n" {
                XrefEntry::Offset {
                    offset: field,
                    generation: generation as u16,
                }
            } else {
                XrefEntry::Free {
                    generation: generation as u16,
                }
            };
            if entries.insert(number as u32, entry).is_some() {
                return Err(bad("Duplicate PDF xref object number"));
            }
        }
    }
    let trailer = lexer.value(0)?.dict()?.clone();
    let size = integer(get(&trailer, b"Size")?, "Size")?;
    if size == 0 || size > MAX_OBJECTS {
        return Err(limit("PDF xref Size exceeds 10000 objects"));
    }
    if entries.keys().any(|number| *number >= size as u32) {
        return Err(bad("PDF xref entry is outside its declared Size"));
    }
    Ok(XrefSection {
        entries,
        trailer,
        end: lexer.at,
    })
}

fn widths(dict: &Dict) -> Result<[usize; 3]> {
    let Value::Array(values) = get(dict, b"W")? else {
        return Err(bad("PDF xref stream W must be an array"));
    };
    if values.len() != 3 {
        return Err(bad("PDF xref stream W must have three integers"));
    }
    let mut output = [0usize; 3];
    for (index, value) in values.iter().enumerate() {
        output[index] = value.integer()?;
        if output[index] > 8 {
            return Err(limit("PDF xref stream field exceeds 8 bytes"));
        }
    }
    if output.iter().sum::<usize>() == 0 || output.iter().sum::<usize>() > 16 {
        return Err(limit("PDF xref stream row is empty or exceeds 16 bytes"));
    }
    Ok(output)
}

fn ranges(dict: &Dict, size: usize) -> Result<Vec<(usize, usize)>> {
    let mut output = Vec::new();
    let mut total = 0usize;
    match dict.get(b"Index".as_slice()) {
        None => output.push((0, size)),
        Some(Value::Array(values)) => {
            if values.is_empty() || values.len() % 2 != 0 {
                return Err(bad("PDF xref Index must contain start/count pairs"));
            }
            for pair in values.chunks_exact(2) {
                let start = pair[0].integer()?;
                let count = pair[1].integer()?;
                if count == 0 || start >= size || count > size - start {
                    return Err(bad("PDF xref Index range is outside Size"));
                }
                total = total
                    .checked_add(count)
                    .filter(|n| *n <= MAX_OBJECTS)
                    .ok_or_else(|| limit("PDF xref exceeds 10000 entries"))?;
                output.push((start, count));
            }
        }
        _ => return Err(bad("PDF xref Index must be an array")),
    }
    if output.len() > MAX_XREF_SECTIONS {
        return Err(limit("PDF xref Index has too many ranges"));
    }
    Ok(output)
}

fn big_endian(bytes: &[u8]) -> usize {
    bytes
        .iter()
        .fold(0usize, |value, byte| (value << 8) | *byte as usize)
}

fn xref_entry(row: &[u8], w: [usize; 3]) -> Result<XrefEntry> {
    let first = 0;
    let second = w[0];
    let third = w[0] + w[1];
    let row_type = if w[0] == 0 {
        1
    } else {
        big_endian(&row[first..second])
    };
    let field1 = big_endian(&row[second..third]);
    let field2 = big_endian(&row[third..third + w[2]]);
    match row_type {
        0 => {
            if field2 > u16::MAX as usize {
                return Err(bad("PDF xref free generation exceeds 65535"));
            }
            Ok(XrefEntry::Free {
                generation: field2 as u16,
            })
        }
        1 => {
            if field1 >= MAX_FILE || field2 > u16::MAX as usize {
                return Err(bad("PDF xref object offset or generation is out of bounds"));
            }
            Ok(XrefEntry::Offset {
                offset: field1,
                generation: field2 as u16,
            })
        }
        2 => {
            if field1 >= MAX_OBJECTS || field2 >= MAX_OBJECTS {
                return Err(bad("PDF compressed object address is out of bounds"));
            }
            Ok(XrefEntry::Compressed {
                stream: field1 as u32,
                index: field2 as u32,
            })
        }
        _ => Err(bad("PDF xref stream contains an unknown entry type")),
    }
}

fn xref_stream_section(data: &[u8], offset: usize) -> Result<XrefSection> {
    let (_, object, end, _) = object_any(data, offset, 0)?;
    let dict = object.value.dict()?;
    if get(dict, b"Type")?.name()? != b"XRef" {
        return Err(unsupported(
            "PDF startxref must name a classic xref table or an xref stream",
        ));
    }
    let size = integer(get(dict, b"Size")?, "Size")?;
    if size == 0 || size > MAX_OBJECTS {
        return Err(limit("PDF xref Size exceeds 10000 objects"));
    }
    let widths = widths(dict)?;
    let index = ranges(dict, size)?;
    let decoded = decode_xref_stream(&object)?;
    let row_len: usize = widths.iter().sum();
    let expected = index
        .iter()
        .map(|(_, count)| *count)
        .sum::<usize>()
        .checked_mul(row_len)
        .ok_or_else(|| limit("PDF xref stream size overflows"))?;
    if decoded.len() != expected {
        return Err(bad(
            "PDF xref stream decoded length disagrees with W and Index",
        ));
    }
    let mut entries = BTreeMap::new();
    let mut at = 0usize;
    for (start, count) in index {
        for number in start..start + count {
            let entry = xref_entry(&decoded[at..at + row_len], widths)?;
            at += row_len;
            if let XrefEntry::Compressed { stream, .. } = &entry
                && *stream as usize >= size
            {
                return Err(bad("PDF compressed object stream is outside xref Size"));
            }
            if entries.insert(number as u32, entry).is_some() {
                return Err(bad("Duplicate PDF xref stream object number"));
            }
        }
    }
    Ok(XrefSection {
        entries,
        trailer: dict.clone(),
        end,
    })
}

fn section(data: &[u8], offset: usize) -> Result<XrefSection> {
    if offset >= data.len() {
        return Err(bad("PDF xref offset is outside the file"));
    }
    if data[offset..].starts_with(b"xref") {
        classic_section(data, offset)
    } else {
        xref_stream_section(data, offset)
    }
}

fn optional_offset(dict: &Dict, key: &[u8]) -> Result<Option<usize>> {
    match dict.get(key) {
        None => Ok(None),
        Some(value) => Ok(Some(value.integer()?)),
    }
}

pub fn parse(data: &[u8]) -> Result<Document<'_>> {
    if data.len() > MAX_FILE {
        return Err(limit("PDF file exceeds 16 MiB"));
    }
    if data.len() < 9
        || &data[..7] != b"%PDF-1."
        || !matches!(data[7], b'0'..=b'7')
        || !matches!(data[8], 10 | 13)
    {
        return Err(unsupported(
            "Only PDF 1.0-1.7 with an exact header is supported",
        ));
    }
    let (start, footer_start) = footer(data)?;
    let mut pending = vec![start];
    let mut seen = BTreeSet::new();
    let mut merged = BTreeMap::new();
    let mut root = None;
    let mut latest_size = None;
    while let Some(offset) = pending.pop() {
        if !seen.insert(offset) {
            return Err(bad("Cyclic PDF xref chain"));
        }
        if seen.len() > MAX_XREF_SECTIONS {
            return Err(limit("PDF xref chain exceeds 64 sections"));
        }
        let current = section(data, offset)?;
        if current.end > footer_start && offset != start {
            return Err(bad("PDF xref section extends beyond the final footer"));
        }
        if root.is_none()
            && let Some(value) = current.trailer.get(b"Root".as_slice())
        {
            root = Some(object_id_number(value)?);
        }
        if latest_size.is_none() {
            latest_size = Some(integer(get(&current.trailer, b"Size")?, "Size")?);
        }
        for (number, entry) in &current.entries {
            merged.entry(*number).or_insert_with(|| entry.clone());
        }
        let hybrid = optional_offset(&current.trailer, b"XRefStm")?;
        let previous = optional_offset(&current.trailer, b"Prev")?;
        drop(current);
        if let Some(previous) = previous {
            if previous >= offset {
                return Err(bad("PDF Prev must point to an earlier xref section"));
            }
            pending.push(previous);
        }
        if let Some(hybrid) = hybrid {
            if hybrid >= offset {
                return Err(bad("PDF XRefStm must point to an earlier xref stream"));
            }
            pending.push(hybrid);
        }
    }
    let root = root.ok_or_else(|| bad("PDF trailer is missing a Root reference"))?;
    let latest_size = latest_size.ok_or_else(|| bad("PDF trailer is missing Size"))?;
    if merged.len() > MAX_OBJECTS {
        return Err(limit("PDF xref exceeds 10000 objects"));
    }
    if merged.keys().any(|number| *number as usize >= latest_size) {
        return Err(bad("PDF xref contains an object outside the latest Size"));
    }
    if let Some(entry) = merged.get(&0)
        && !matches!(entry, XrefEntry::Free { generation: 65_535 })
    {
        return Err(bad("PDF object zero must be free with generation 65535"));
    }

    let mut direct = Vec::new();
    for (number, entry) in &merged {
        match entry {
            XrefEntry::Offset { offset, generation } => {
                if *offset < 9 || *offset >= footer_start {
                    return Err(bad(
                        "Active PDF object offset is outside the object section",
                    ));
                }
                direct.push((*offset, (*number, *generation)));
            }
            XrefEntry::Free { .. } | XrefEntry::Compressed { .. } => {}
        }
    }
    direct.sort_unstable();
    for pair in direct.windows(2) {
        if pair[0].0 == pair[1].0 {
            return Err(bad("Two PDF objects share the same offset"));
        }
    }

    let mut nodes = 0usize;
    let mut objects = BTreeMap::new();
    let mut previous_end = 9usize;
    for (offset, expected) in direct {
        if offset < previous_end {
            return Err(bad("PDF object ranges overlap"));
        }
        let (id, item, end, count) = object_any(data, offset, nodes)?;
        if id != expected {
            return Err(bad("PDF xref object identity mismatch"));
        }
        previous_end = end;
        nodes = count;
        objects.insert(id, item);
    }

    let mut compressed: BTreeMap<u32, Vec<(u32, u32)>> = BTreeMap::new();
    for (number, entry) in merged {
        if let XrefEntry::Compressed { stream, index } = entry {
            compressed.entry(stream).or_default().push((number, index));
        }
    }
    for (stream, requests) in compressed {
        let object = objects
            .get(&(stream, 0))
            .ok_or_else(|| bad("PDF object stream is not active"))?;
        let dict = object.value.dict()?;
        if get(dict, b"Type")?.name()? != b"ObjStm" {
            return Err(bad("PDF compressed object names a non-ObjStm object"));
        }
        let count = integer(get(dict, b"N")?, "ObjStm N")?;
        let first = integer(get(dict, b"First")?, "ObjStm First")?;
        if count == 0 || count > MAX_OBJECTS || first > MAX_STREAM {
            return Err(limit("PDF object stream metadata is outside its bounds"));
        }
        let decoded = decode(object)?;
        if first > decoded.len() {
            return Err(bad("PDF object stream First exceeds its decoded data"));
        }
        let mut header = Lexer::new(&decoded);
        let mut pairs = Vec::with_capacity(count);
        for _ in 0..count {
            let number = header.unsigned()?;
            let relative = header.unsigned()?;
            if number >= MAX_OBJECTS {
                return Err(bad("PDF object stream object number is out of bounds"));
            }
            pairs.push((number, relative));
        }
        header.skip();
        if header.at != first {
            return Err(bad("PDF object stream header does not end at First"));
        }
        nodes = header.nodes;
        let mut parsed = Vec::with_capacity(requests.len());
        for (number, index) in requests {
            let Some((stored, relative)) = pairs.get(index as usize) else {
                return Err(bad("PDF compressed object index is outside ObjStm N"));
            };
            if *stored != number as usize {
                return Err(bad("PDF compressed object number disagrees with ObjStm"));
            }
            let at = first
                .checked_add(*relative)
                .filter(|at| *at < decoded.len())
                .ok_or_else(|| bad("PDF compressed object offset is outside ObjStm"))?;
            let mut lexer = Lexer {
                data: &decoded,
                at,
                nodes,
            };
            let value = lexer.value(0)?;
            nodes = lexer.nodes;
            parsed.push((
                (number, 0),
                Object {
                    value,
                    stream: None,
                },
            ));
        }
        for (id, item) in parsed {
            if objects.insert(id, item).is_some() {
                return Err(bad("PDF xref resolves the same object twice"));
            }
        }
    }

    let document = Document { objects, root };
    let root_object = document.object(root)?;
    if root_object.stream.is_some() {
        return Err(bad("PDF Root cannot be a stream"));
    }
    root_object.value.dict()?;
    Ok(document)
}

fn inflate(raw: &[u8]) -> Result<Vec<u8>> {
    let mut decoder = flate2::Decompress::new(true);
    let mut output = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        let before_in = decoder.total_in() as usize;
        let before_out = decoder.total_out() as usize;
        let room = (MAX_STREAM + 1 - output.len()).min(buffer.len());
        let status = decoder
            .decompress(
                &raw[before_in..],
                &mut buffer[..room],
                flate2::FlushDecompress::None,
            )
            .map_err(|_| bad("Invalid PDF zlib stream or checksum"))?;
        let written = decoder.total_out() as usize - before_out;
        output.extend_from_slice(&buffer[..written]);
        if output.len() > MAX_STREAM {
            return Err(limit("PDF decoded stream exceeds 1 MiB"));
        }
        if status == flate2::Status::StreamEnd {
            if decoder.total_in() as usize != raw.len() {
                return Err(bad("Trailing data after PDF zlib stream"));
            }
            return Ok(output);
        }
        if decoder.total_in() as usize == before_in && written == 0 {
            return Err(bad("Truncated PDF zlib stream"));
        }
    }
}

fn decode_filtered(dict: &Dict, raw: &[u8]) -> Result<Vec<u8>> {
    if dict.contains_key(b"F".as_slice()) {
        return Err(unsupported("PDF external stream data is unsupported"));
    }
    let Some(filter) = dict.get(b"Filter".as_slice()) else {
        return Ok(raw.to_vec());
    };
    let filter = match filter {
        Value::Array(filters) if filters.len() == 1 => &filters[0],
        value => value,
    };
    if filter.name()? != b"FlateDecode" {
        return Err(unsupported(
            "Only unfiltered or single FlateDecode PDF streams are supported",
        ));
    }
    inflate(raw)
}

pub fn decode(object: &Object<'_>) -> Result<Vec<u8>> {
    let raw = object.stream.ok_or_else(|| bad("Expected a PDF stream"))?;
    if raw.len() > MAX_STREAM {
        return Err(limit("PDF encoded stream exceeds 1 MiB"));
    }
    let dict = object.value.dict()?;
    if dict.contains_key(b"DecodeParms".as_slice()) {
        return Err(unsupported(
            "PDF stream predictors and decode parameters are unsupported",
        ));
    }
    decode_filtered(dict, raw)
}

fn png_predictor(
    bytes: &[u8],
    predictor: usize,
    columns: usize,
    colors: usize,
    bits: usize,
) -> Result<Vec<u8>> {
    if columns == 0 || columns > MAX_STREAM || colors == 0 || !matches!(bits, 1 | 2 | 4 | 8 | 16) {
        return Err(bad("Invalid PDF PNG predictor dimensions"));
    }
    let row = columns;
    let tagged = bytes.len() % (row + 1) == 0
        && bytes
            .chunks_exact(row + 1)
            .all(|chunk| chunk.first().is_some_and(|tag| *tag <= 4));
    let stride = if tagged { row + 1 } else { row };
    if bytes.len() % stride != 0 {
        return Err(bad("PDF PNG predictor data has an incomplete row"));
    }
    let bpp = (colors * bits).div_ceil(8).max(1);
    let mut output = Vec::with_capacity(bytes.len() / stride * row);
    let mut previous = vec![0u8; row];
    for encoded in bytes.chunks_exact(stride) {
        let (filter, source) = if tagged {
            (encoded[0], &encoded[1..])
        } else if predictor <= 14 {
            ((predictor - 10) as u8, encoded)
        } else {
            return Err(bad("PDF PNG predictor row lacks a filter byte"));
        };
        let mut current = vec![0u8; row];
        for index in 0..row {
            let left = if index >= bpp {
                current[index - bpp]
            } else {
                0
            };
            let up = previous[index];
            let upper_left = if index >= bpp {
                previous[index - bpp]
            } else {
                0
            };
            let predicted = match filter {
                0 => 0,
                1 => left,
                2 => up,
                3 => ((left as u16 + up as u16) / 2) as u8,
                4 => paeth(left, up, upper_left),
                _ => return Err(bad("Unknown PDF PNG predictor filter")),
            };
            current[index] = source[index].wrapping_add(predicted);
        }
        output.extend_from_slice(&current);
        previous = current;
    }
    Ok(output)
}

fn paeth(left: u8, up: u8, upper_left: u8) -> u8 {
    let p = left as i32 + up as i32 - upper_left as i32;
    let pa = (p - left as i32).abs();
    let pb = (p - up as i32).abs();
    let pc = (p - upper_left as i32).abs();
    if pa <= pb && pa <= pc {
        left
    } else if pb <= pc {
        up
    } else {
        upper_left
    }
}

fn decode_xref_stream(object: &Object<'_>) -> Result<Vec<u8>> {
    let raw = object
        .stream
        .ok_or_else(|| bad("PDF xref stream has no data"))?;
    if raw.len() > MAX_STREAM {
        return Err(limit("PDF encoded xref stream exceeds 1 MiB"));
    }
    let dict = object.value.dict()?;
    let bytes = decode_filtered(dict, raw)?;
    let Some(params) = dict.get(b"DecodeParms".as_slice()) else {
        return Ok(bytes);
    };
    let params = match params {
        Value::Dict(dict) => dict,
        Value::Null => return Ok(bytes),
        Value::Array(values)
            if values.len() == 1 && matches!(values.first(), Some(Value::Dict(_))) =>
        {
            values[0].dict()?
        }
        Value::Array(values)
            if values.len() == 1 && matches!(values.first(), Some(Value::Null)) =>
        {
            return Ok(bytes);
        }
        _ => return Err(bad("PDF xref DecodeParms must be one dictionary")),
    };
    let predictor = match params.get(b"Predictor".as_slice()) {
        None => 1,
        Some(value) => value.integer()?,
    };
    match predictor {
        1 => Ok(bytes),
        2..=9 => Err(unsupported(
            "TIFF predictors on PDF xref streams are unsupported",
        )),
        10..=15 => {
            let columns = match params.get(b"Columns".as_slice()) {
                None => 1,
                Some(value) => value.integer()?,
            };
            let colors = match params.get(b"Colors".as_slice()) {
                None => 1,
                Some(value) => value.integer()?,
            };
            let bits = match params.get(b"BitsPerComponent".as_slice()) {
                None => 8,
                Some(value) => value.integer()?,
            };
            png_predictor(&bytes, predictor, columns, colors, bits)
        }
        _ => Err(unsupported("Unknown PDF xref predictor")),
    }
}

#[cfg(test)]
#[path = "pdf_container_tests.rs"]
mod tests;
