# Tool Usage Guide

## exec
Execute terminal commands. Use for system operations, running scripts, installing packages, etc.
- Commands have a 30-second timeout
- For long-running tasks, consider backgrounding them
- Always be cautious with destructive commands (rm -rf, etc.)

## file_read
Read file contents. Use to inspect files, check configurations, review code.
- Files larger than 50,000 characters will be truncated
- Use for text files; binary files won't display correctly

## file_write
Write content to files. Creates the file if it doesn't exist, overwrites if it does.
- Parent directories are created automatically
- Always confirm before overwriting important files

## file_list
List files and directories. Use to explore the filesystem.
- Set recursive=true for deep listings
- Useful for understanding project structure
