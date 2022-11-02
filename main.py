from flask import Flask, request, render_template, redirect, url_for
import datetime
import json
import requests
import uuid

need_to_write = False


app = Flask(__name__)


@app.route("/")
def home():
    return render_template('index.html')


@app.route("/create-task", methods=["POST", "GET"])
def create_task():
    return render_template('create-task.html')


@app.route("/view-tasks", methods=["POST", "GET"])
def view_tasks():
    from locks import get_tasks

    tasks = get_tasks()

    for task in tasks.values():
        task["zones"] = list(map(str, task["zones"]))
        task["start_time"] = datetime.datetime.strptime(task["start_time"], "%H:%M")

        try:
            task["last_run"] = datetime.datetime.strptime(task["last_run"], "%Y-%m-%d %H:%M:%S")
            task["last_run"] = datetime.datetime.now() - task["last_run"]
            task["last_run"] = str(task["last_run"].days) + " days ago"
        except KeyError:
            task["last_run"] = "Never run"

    return render_template('view-tasks.html', tasks=tasks)


@app.route("/edit-task", methods=["POST"])
def edit_task():
    from locks import get_tasks

    if request.method != "POST":
        return "Error"

    task_id = request.form.get("id")

    tasks = get_tasks()

    task = tasks.get(task_id)

    return render_template('edit-task.html', task=task, task_id=task_id)


@app.route("/quick-task", methods=["GET"])
def quick_task():
    return render_template('quick-task.html')


@app.route("/api/create-task", methods=["POST"])
def api_create_task():
    from locks import lock

    if request.method != "POST":
        return "Error"

    week = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

    days = [day for day in week if dict(request.form).get(day) == 'on']

    zones = [i for i in range(1, 9) if dict(request.form).get(f"zone{i}") == 'on']

    start_time = dict(request.form).get('start-time')
    try:
        run_time = int(dict(request.form).get('end-time'))
    except ValueError:
        return "Missing Information"

    individual = dict(request.form).get('individual') == 'on'

    task = {
        "days": days,
        "zones": zones,
        "start_time": start_time,
        "run_time": run_time,
        "individual": individual,
        "started": False
    }

    lock.acquire()

    with open('tasks.json', 'r') as f:
        tasks = json.load(f)

    tasks[str(uuid.uuid4())] = task

    with open('tasks.json', 'w') as f:
        json.dump(tasks, f)

    lock.release()

    return redirect(url_for('home'))


@app.route("/api/edit-task", methods=["POST"])
def api_edit_task():
    from locks import lock, get_tasks

    if request.method != "POST":
        return "Error"

    task_id = request.form.get("id")

    tasks = get_tasks()

    task = tasks.get(task_id)

    week = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

    days = [day for day in week if dict(request.form).get(day) == 'on']

    zones = [i for i in range(1, 9) if dict(request.form).get(f"zone{i}") == 'on']

    start_time = dict(request.form).get('start-time')
    end_time = int(dict(request.form).get('end-time'))

    individual = dict(request.form).get('individual') == 'on'

    task["days"] = days
    task["start_time"] = start_time
    task["run_time"] = end_time
    task["individual"] = individual
    task["zones"] = zones

    lock.acquire()

    with open('tasks.json', 'w') as f:
        json.dump(tasks, f)

    lock.release()

    return redirect(url_for('view_tasks'))


@app.route("/api/delete-task", methods=["POST"])
def api_delete_task():
    from locks import lock

    if request.method != "POST":
        return "Error"

    task_id = dict(request.form).get('id')

    requests.post("/api/stop-task", json={"id": task_id})

    lock.acquire()

    with open('tasks.json', 'r') as f:
        tasks = json.load(f)

    tasks.pop(task_id)

    with open('tasks.json', 'w') as f:
        json.dump(tasks, f)

    lock.release()

    return redirect(url_for('view_tasks'))


@app.route("/api/start-task")
def api_start_task():
    from locks import lock

    args = request.args.to_dict()

    task_id = dict(args).get('id').strip("\"")

    lock.acquire()

    with open('tasks.json', 'r') as f:
        tasks = json.load(f)

    tasks.get(task_id)["started"] = True
    tasks.get(task_id)["last_run"] = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    with open('tasks.json', 'w') as f:
        json.dump(tasks, f, indent=4)

    lock.release()

    return "Success"


@app.route("/api/stop-task", methods=["POST"])
def api_stop_task():
    from locks import lock

    if request.method != "POST":
        return "Error"

    task_id = dict(request.json).get('id')

    lock.acquire()

    with open('tasks.json', 'r') as f:
        tasks = json.load(f)

    tasks.get(task_id)["started"] = False

    with open('tasks.json', 'w') as f:
        json.dump(tasks, f)

    lock.release()

    return "Success"


@app.route("/api/get-active", methods=["GET"])
def api_get_active():
    from locks import get_tasks, lock
    tasks = get_tasks()

    active = []

    current_time = datetime.datetime.now().time()
    current_weekday = datetime.datetime.now().strftime("%A")

    for id, task in tasks.items():
        task_start_time = datetime.datetime.strptime(task["start_time"], "%H:%M")
        task_end_time = (task_start_time + datetime.timedelta(minutes=task["run_time"])).time()
        task_start_time = task_start_time.time()

        run_time = datetime.datetime.strptime(
            str(task_end_time), "%H:%M:%S") - datetime.datetime.strptime(str(current_time), "%H:%M:%S.%f")

        if task_start_time <= current_time <= task_end_time:
            if current_weekday in task["days"]:
                if not task["started"]:

                    task.pop("days")
                    task.pop("start_time")
                    task.pop("started")
                    task["total_run_time"] = task["run_time"] * 60 * 1000
                    task['run_time'] = run_time.seconds * 1000
                    task["id"] = id
                    task["total_zones"] = len(task["zones"])
                    active.append(task)

    tasks = get_tasks()

    for id, task in tasks.items():
        task_start_time = datetime.datetime.strptime(task["start_time"], "%H:%M")
        task_end_time = (task_start_time + datetime.timedelta(minutes=task["run_time"])).time()
        task_start_time = task_start_time.time()

        if not (task_start_time <= current_time <= task_end_time):
            tasks.get(id)["started"] = False

    lock.acquire()

    with open('tasks.json', 'w') as f:
        json.dump(tasks, f, indent=4)

    lock.release()

    print(json.dumps(active))

    return json.dumps(active)


if __name__ == "__main__":
    app.run(host="0.0.0.0")
