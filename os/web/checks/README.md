`invalid-crc.zip` contains only two short synthetic text payloads named after
required DAT files, never original Fallout data. The first stored payload was
changed after ZIP creation without updating its CRC. It must always fail import
and must never activate. This fixture allows a real phone failure/recovery check
without making a damaged copy of the user's multi-gigabyte archive.
