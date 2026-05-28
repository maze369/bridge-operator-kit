FROM python:3.11-slim
WORKDIR /app
RUN pip install --no-cache-dir aiohttp==3.9.* pyyaml==6.0.*
COPY proxy.py /app/proxy.py
EXPOSE 8545
CMD ["python", "-u", "/app/proxy.py"]
