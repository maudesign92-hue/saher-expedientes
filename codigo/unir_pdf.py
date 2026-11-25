#!/usr/bin/env python3
"""
Une varios archivos PDF en orden usando pypdf.
Uso: python3 unir_pdf.py <salida.pdf> <entrada1.pdf> <entrada2.pdf> ...
"""
import sys
from pypdf import PdfWriter, PdfReader

def main():
    if len(sys.argv) < 3:
        print("Uso: python3 unir_pdf.py <salida.pdf> <entrada1.pdf> [entrada2.pdf ...]", file=sys.stderr)
        sys.exit(1)

    salida = sys.argv[1]
    entradas = sys.argv[2:]
    writer = PdfWriter()

    for ruta in entradas:
        reader = PdfReader(ruta)
        for page in reader.pages:
            writer.add_page(page)

    with open(salida, "wb") as f:
        writer.write(f)

if __name__ == "__main__":
    main()
